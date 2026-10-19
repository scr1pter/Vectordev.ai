import { Context, Duration, Effect, Exit, Layer, Option } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import type { Brain } from "@vectordevai/core/brain/brain"
import { BrainDistill } from "@vectordevai/core/brain/distill"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import type { BrainSchema } from "@vectordevai/core/brain/schema"
import { Flag } from "@vectordevai/core/flag/flag"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { providerCredentialAllowed } from "@vectordevai/core/provider-policy"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import { isFreeModel } from "@vectordevai/schema/free-model"
import { Auth } from "@/auth"
import { measureCost } from "@/cli/cmd/github.evidence"
import { Provider } from "@/provider/provider"
import { SessionAdmission } from "./admission"
import { SessionPrompt } from "./prompt"
import type { SessionID } from "./schema"
import { Session } from "./session"

// "Find more with a model…": a model the user chose reads a document's sparse sections in a hidden helper session, so no
// session opens for the user, and what it suggests is quote-locked (BrainDistill) and kept as proposed records. The
// helper's tokens and cost go on the document's History and into usage, and count towards the session it was asked
// from, if any. It is off unless VECTOR_KNOWLEDGE_DISTILL is set, and refused for a session a guest is in, a model that
// may train on prompts and the Zen gateway. One provider request at most, of at most 4,000 output tokens.

export type Input = {
  readonly document: string
  /** "provider/model"; the configured default model when absent. */
  readonly model?: string
  /** Section text to send, in tokens: at most 30,000, the default. */
  readonly maxTokens?: number
  /** The session it was asked from: a guest in it refuses the request, and the helper's spend counts there. */
  readonly sessionID?: SessionID
}

export type Reason = BrainDistill.Refusal | "no-model" | "not-found" | "held" | "not-ready" | "nothing"

export type Refused = { readonly type: "refused"; readonly reason: Reason; readonly message: string }

/** What a request would send and may cost, shown before it runs. */
export type Estimate = {
  readonly enabled: boolean
  readonly model?: string
  readonly refused?: { readonly reason: Reason; readonly message: string }
  /** Sections and tokens that would be sent, and the output cap. */
  readonly sections: number
  readonly input: number
  readonly output: number
  readonly costKind?: SpendGuard.CostKind
  /** At catalog rates, for a priced model. */
  readonly lowUsd?: number
  readonly highUsd?: number
}

export type Distilled = {
  readonly type: "distilled"
  readonly model: string
  /** The hidden helper session. */
  readonly sessionID: SessionID
  readonly records: readonly BrainSchema.Record[]
  readonly duplicate: number
  readonly dropped: BrainDistill.Dropped
  readonly tokens: BrainKnowledge.DistillRun["tokens"]
  readonly cost: number
  readonly costKind: SpendGuard.CostKind
  /** Why the model gave nothing usable, when it did not. */
  readonly error?: string
}

export interface Interface {
  readonly estimate: (place: Brain.Place, input: Input) => Effect.Effect<Estimate>
  readonly run: (place: Brain.Place, input: Input) => Effect.Effect<Refused | Distilled>
}

export class Service extends Context.Service<Service, Interface>()("@vector/SessionDistill") {}

/** The longest the helper's one request may take. */
export const TIMEOUT = Duration.minutes(5)

// Every tool and question denied, StructuredOutput allowed back: the session's rules come after the agent's own.
const RULES: PermissionV1.Rule[] = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "StructuredOutput", pattern: "*", action: "allow" },
]

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const provider = yield* Provider.Service
    const auth = yield* Auth.Service
    const guests = yield* FreeModelGuests.Service
    const knowledge = yield* BrainKnowledge.Service

    // Everything a request needs settled before it may run: the flag, the session, the model and what it would send.
    const plan = Effect.fnUntraced(function* (place: Brain.Place, input: Input) {
      const enabled = Flag.VECTOR_KNOWLEDGE_DISTILL
      const guest = yield* guests.marked(input.sessionID)
      const off = BrainDistill.refusal({ enabled, guest })
      if (off) return refuse(off.reason, off.message)
      const chosen = input.model?.trim()
        ? Provider.parseModel(input.model.trim())
        : Option.getOrUndefined(yield* provider.defaultModel().pipe(Effect.option))
      const model =
        chosen?.providerID && chosen.modelID
          ? Option.getOrUndefined(yield* provider.getModel(chosen.providerID, chosen.modelID).pipe(Effect.option))
          : undefined
      if (!model)
        return refuse(
          "no-model",
          input.model ? `${input.model} is not available. Check the provider and its key.` : "Connect a provider or choose a model first.",
        )
      const info = yield* provider.getProvider(model.providerID).pipe(Effect.option)
      const urls = [model.api.url, Option.isSome(info) ? info.value.options.baseURL : undefined].filter(
        (url): url is string => typeof url === "string",
      )
      const refused = BrainDistill.refusal({ enabled, guest, model, urls })
      if (refused) return refuse(refused.reason, refused.message)
      const source = yield* knowledge.distillable(place, input.document)
      if (!source) return refuse("not-found", `No document ${input.document} here.`)
      if (source.type === "refused") return refuse(source.reason, source.message)
      const picked = BrainDistill.choose(source.sections, input.maxTokens ?? BrainDistill.LIMIT.input)
      if (picked.sections.length === 0)
        return refuse(
          "nothing",
          "Vector's rules already found records throughout this document, so there is nothing for a model to read.",
        )
      const signIn = yield* auth.get(model.providerID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const costKind = SpendGuard.costKindOf({
        free: isFreeModel(model),
        oauthPlan:
          signIn?.type === "oauth" &&
          providerCredentialAllowed(model.providerID, signIn, Boolean(model.api.npm || model.api.url)),
        listed: model.cost.input > 0 || model.cost.output > 0,
      })
      return {
        type: "plan" as const,
        model,
        name: `${model.providerID}/${model.id}`,
        document: source.document,
        picked,
        costKind,
        estimate: BrainDistill.estimate({
          tokens: picked.tokens,
          ...(costKind === "priced" ? { price: SpendGuard.priceOf(model.cost) } : {}),
        }),
      }
    })

    const estimate = Effect.fn("SessionDistill.estimate")(function* (place: Brain.Place, input: Input) {
      const planned = yield* plan(place, input)
      if (planned.type === "refused")
        return {
          enabled: planned.reason !== "off",
          refused: { reason: planned.reason, message: planned.message },
          sections: 0,
          input: 0,
          output: BrainDistill.LIMIT.output,
        } satisfies Estimate
      return {
        enabled: true,
        model: planned.name,
        sections: planned.picked.sections.length,
        costKind: planned.costKind,
        ...planned.estimate,
      } satisfies Estimate
    })

    const run = Effect.fn("SessionDistill.run")(function* (place: Brain.Place, input: Input) {
      const planned = yield* plan(place, input)
      if (planned.type === "refused") return planned
      // A helper session: it stays out of session lists, and counts towards the session it was asked from.
      const session = yield* sessions.create({
        title: `Document suggestions · ${planned.document.title}`,
        internal: BrainDistill.HELPER,
        ...(input.sessionID ? { parentID: input.sessionID } : {}),
        permission: RULES,
      })
      // One provider request, whatever happens to it: a reply that does not validate is not asked for again.
      const attempts = { count: 0 }
      const policy: SessionAdmission.Policy = {
        sessionID: session.id,
        admit: () => {
          if (attempts.count >= 1) return undefined
          attempts.count++
          return { tools: ["StructuredOutput"], settle: () => {} }
        },
      }
      const exit = yield* prompts
        .prompt({
          sessionID: session.id,
          agent: "distill",
          model: { providerID: planned.model.providerID, modelID: planned.model.id },
          format: new SessionV1.OutputFormatJsonSchema({ type: "json_schema", schema: BrainDistill.SCHEMA, retryCount: 0 }),
          parts: [{ type: "text", text: BrainDistill.prompt({ title: planned.document.title, sections: planned.picked.sections }) }],
        })
        .pipe(
          Effect.provideService(SessionAdmission.Current, policy),
          Effect.timeoutOption(TIMEOUT),
          Effect.ensuring(prompts.cancel(session.id)),
          Effect.exit,
        )
      const reply = Exit.isSuccess(exit) ? Option.getOrUndefined(exit.value) : undefined
      const assistant = reply?.info.role === "assistant" ? reply.info : undefined
      const decoded = BrainDistill.decode(assistant?.structured)
      const locked = BrainDistill.lock(planned.picked.sections, decoded.drafts)
      const error = !reply
        ? Exit.isSuccess(exit)
          ? "The model took too long to answer."
          : "The request to the model failed."
        : assistant?.structured === undefined
          ? (failure(assistant) ?? "The model gave no suggestions Vector could read.")
          : undefined
      const spent = measureCost(yield* sessions.messages({ sessionID: session.id }).pipe(Effect.orDie))
      const tokens = {
        input: spent?.input ?? 0,
        output: spent?.output ?? 0,
        reasoning: spent?.reasoning ?? 0,
        cacheRead: spent?.cacheRead ?? 0,
        cacheWrite: spent?.cacheWrite ?? 0,
      }
      const cost = spent && Number.isFinite(spent.costUsd) ? spent.costUsd : 0
      const dropped = { invalid: assistant?.structured === undefined ? 0 : decoded.invalid, ...locked.dropped }
      const stored = yield* knowledge.distilled(place, input.document, {
        records: locked.kept,
        run: {
          model: planned.name,
          session: session.id,
          tokens,
          cost,
          costKind: planned.costKind,
          dropped,
          ...(error ? { error } : {}),
        },
      })
      return {
        type: "distilled" as const,
        model: planned.name,
        sessionID: session.id,
        records: stored?.records ?? [],
        duplicate: stored?.duplicate ?? 0,
        dropped,
        tokens,
        cost,
        costKind: planned.costKind,
        ...(error ? { error } : {}),
      } satisfies Distilled
    })

    return Service.of({ estimate, run })
  }),
)

function refuse(reason: Reason, message: string): Refused {
  return { type: "refused", reason, message }
}

// The provider's own words for why a request failed, when it gave any.
function failure(assistant: SessionV1.Assistant | undefined) {
  const data: unknown = assistant?.error?.data
  return typeof data === "object" && data !== null && "message" in data && typeof data.message === "string"
    ? data.message
    : undefined
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, SessionPrompt.node, Provider.node, Auth.node, FreeModelGuests.node, BrainKnowledge.node],
})

export * as SessionDistill from "./distill"
