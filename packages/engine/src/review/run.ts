// Review.run (section 3.8): one read-only session per specialist, with Vector's own step, dollar and time limits, a
// finalize prompt for a session stopped early, a verify pass, then selection and cost. The engine's agent `steps`
// limit only adds text-only prompt guidance, which conflicts with this runner's required StructuredOutput tool.
// Review admits each provider attempt, including retries, and one separate finalizer. Dollar reservations are
// estimates; reported usage can exceed them, so they are not a hard billing cap.

import path from "path"
import { Cause, Duration, Effect, Exit, Option, Scope } from "effect"
import type { EventV2 } from "@vectordevai/core/event"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import {
  anchorText,
  budgetDiff,
  buildAnchorIndex,
  lookupFile,
  renderPatch,
  resolveAnchor,
  type DiffFile,
} from "@vectordevai/core/review/diff"
import { fingerprint, normalizeCode, normalizeTitle } from "@vectordevai/core/review/fingerprint"
import { noteVerifySkipped } from "@vectordevai/core/review/format"
import { classifyPath, isSensitivePath } from "@vectordevai/core/review/ignore"
import { reviewPermissionRules } from "@vectordevai/core/review/permission"
import {
  diffBudgetChars,
  estimateCostUsd,
  NEXT_STEP_SLACK,
  nextStepCostUsd,
  planSpecialists,
} from "@vectordevai/core/review/plan"
import {
  buildFinalizePrompt,
  buildReviewPrompt,
  buildSecurityPrompt,
  buildVerifyPrompt,
  type PromptInput,
} from "@vectordevai/core/review/prompt"
import {
  decodeReport,
  decodeVerify,
  REVIEW_REPORT_JSON_SCHEMA,
  VERIFY_JSON_SCHEMA,
} from "@vectordevai/core/review/schema"
import { selectFindings } from "@vectordevai/core/review/select"
import type {
  Finding,
  FocusHunk,
  ModelFinding,
  ModelReport,
  PriorFinding,
  ReviewConfig,
  ReviewCost,
  ReviewOutcome,
  Risk,
  SkippedFile,
  Trigger,
  Trust,
} from "@vectordevai/core/review/types"
import { measureCost } from "@/cli/cmd/github.evidence"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import type { Provider } from "@/provider/provider"
import { SessionPrompt } from "@/session/prompt"
import { SessionAdmission } from "@/session/admission"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import type { ResolvedModel } from "./model"

export interface RunInput {
  directory: string
  trigger: Trigger
  trust: Trust
  base: string // the merge-base
  head: string
  since?: string
  mode: "full" | "incremental"
  files: DiffFile[] // the PR diff for the model, classified and filtered
  anchors: DiffFile[] // the diff findings are anchored against
  focus?: FocusHunk[]
  skipped: SkippedFile[]
  headFiles?: { path: string; text: string; exact: boolean }[]
  context: Pick<PromptInput, "related" | "history" | "instructions" | "teamDismissed" | "humanComments">
  pr?: PromptInput["pr"]
  prior: PriorFinding[]
  rules: string
  config: ReviewConfig
  model: ResolvedModel
  allowDirs?: string[]
  checks?: boolean
  knownPath: (path: string) => Promise<boolean>
  onProgress?: (e: { type: "specialist"; name: string; status: string } | { type: "cost"; costUsd: number }) => void
  onCheckpoint?: (spent: ReviewCost) => Promise<void>
  baseRef?: string // the base branch name, for the prompt
  rulesSource?: PromptInput["rulesSource"] // defaults to the working tree for local and desktop runs
  inlinePosted?: number // state.inlinePosted, for the per-PR inline cap
}

type Name = ReviewOutcome["specialists"][number]["name"]
type Stop = "budget" | "steps" | "timeout"
type Progress = Parameters<NonNullable<RunInput["onProgress"]>>[0]

interface Track {
  name: Name
  sessionID: SessionID
  cap: number
  steps: number
  seen: Set<string>
  context: number // tokens the last step sent, cached ones included
  cached: number // of which the provider reported as cache reads
  stop?: Stop
  attempts: number // invocation admission counts retries and missing-usage failures, independently of steps
  finalizeAttempts: number
  finalizing: boolean
  denied: boolean
}

interface Spec<T> {
  name: Name
  cap: number
  text: string
  schema: Record<string, unknown>
  decode: (value: unknown) => T | undefined
}

interface Asked<T> {
  name: Name
  sessionID?: SessionID
  value?: T
  status: ReviewOutcome["specialists"][number]["status"]
  stop?: Stop // includes a request refused before admission
  steps: number
  detail?: string
}

type Sent = { timedOut: true } | { timedOut: false; message?: SessionV1.WithParts }

const VERIFY_STEPS = 10
const FINALIZE_MS = 90_000
const VERIFY_MIN_MS = 2 * 60_000
const DENY_ALL: PermissionV1.Rule = { permission: "*", pattern: "*", action: "deny" }
const ALLOW_OUTPUT: PermissionV1.Rule = { permission: "StructuredOutput", pattern: "*", action: "allow" }

export const run: (
  input: RunInput,
) => Effect.Effect<
  ReviewOutcome,
  never,
  Session.Service | SessionPrompt.Service | Permission.Service | EventV2Bridge.Service | Provider.Service
> = Effect.fn("Review.run")(function* (input: RunInput) {
  const sessions = yield* Session.Service
  const prompts = yield* SessionPrompt.Service
  const permission = yield* Permission.Service
  const events = yield* EventV2Bridge.Service

  const started = Date.now()
  const deadline = started + input.config.timeoutMinutes * 60_000
  const config = input.config
  const price = input.model.costKind === "priced" && config.maxCostUsd > 0 ? input.model.price : undefined
  // The saved long outputs hold every session the user ever ran, so a review of someone else's pull request, which its
  // author can steer, cannot read them back; it only loses the cut-off end of a long tool output.
  const rules = reviewPermissionRules({
    allowDirs: input.allowDirs,
    checks: input.checks,
    truncateGlob: input.trust === "untrusted" ? undefined : Truncate.GLOB,
  })
  const tracks = new Map<string, Track>()
  const reservations = new Map<Name, { turn: number; finalize: number }>()
  const sessionIDs: SessionID[] = []
  const state = { spent: 0, reported: 0, uncertain: 0, incomplete: false }
  const scope = yield* Scope.make()

  const progress = (event: Progress) =>
    Effect.sync(() => input.onProgress?.(event)).pipe(Effect.catchCause(() => Effect.void))

  // Reservations are estimates, not billed spend. Replace this specialist's old reservation in one synchronous
  // operation: parallel specialists must not each spend the same remainder, including a pending finalization.
  const reserve = (name: Name, turn: number, finalize: number) => {
    if (!price) return true
    const others = [...reservations].reduce(
      (total, [owner, amount]) => total + (owner === name ? 0 : amount.turn + amount.finalize),
      0,
    )
    if (state.spent + state.uncertain + others + turn + finalize > config.maxCostUsd) return false
    reservations.set(name, { turn, finalize })
    return true
  }
  const nextCost = (track: Pick<Track, "context" | "cached">) =>
    price ? nextStepCostUsd(track.context + NEXT_STEP_SLACK, price, track.cached) : 0
  // Usage is settled by the processor lease before retry/continuation admission. Events only report progress.
  const unsubscribe = yield* events.listen((event) => {
    if (event.type === SessionV1.Event.PartUpdated.type) {
      const part = (event.data as EventV2.Data<typeof SessionV1.Event.PartUpdated>).part
      const track = tracks.get(part.sessionID)
      if (!track) return Effect.void
      if (part.type !== "step-finish" || track.seen.has(part.id)) return Effect.void
      track.seen.add(part.id)
      track.steps++
      state.reported += part.cost
      return progress({ type: "cost", costUsd: state.reported })
    }
    if (event.type === Permission.Event.Asked.type) {
      // Nothing is set to ask, so nothing should; if something does, it is refused rather than left waiting.
      const request = event.data as EventV2.Data<typeof Permission.Event.Asked>
      if (!tracks.has(request.sessionID)) return Effect.void
      return permission
        .reply({ requestID: request.id, reply: "reject" })
        .pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid)
    }
    return Effect.void
  })

  const measure = Effect.fnUntraced(function* () {
    const children = (yield* Effect.forEach(sessionIDs, (id) => sessions.children(id))).flat().map((child) => child.id)
    const messages = yield* Effect.forEach([...sessionIDs, ...children], (id) =>
      sessions.messages({ sessionID: id }).pipe(
        Effect.map((messages) => ({ messages, complete: true })),
        Effect.catch(() => Effect.succeed({ messages: [], complete: false })),
      ),
    )
    const recorded = messages
      .flatMap((entry) => entry.messages)
      .filter((message) => message.info.role !== "assistant" || !message.info.forked)
    const measured = measureCost(recorded)
    // Admission can refuse the first request after an empty assistant marker is stored. No admitted attempt
    // means no provider spend; an attempted request without usage must still remain unknown.
    const unused =
      children.length === 0 &&
      [...tracks.values()].every((track) => track.attempts === 0 && track.finalizeAttempts === 0)
    const assistant = recorded.flatMap((message) => (message.info.role === "assistant" ? [message.info] : []))
    const incomplete =
      messages.some((entry) => !entry.complete) ||
      assistant.some((message) => message.unpriced || !Number.isFinite(message.cost) || message.cost < 0)
    const sameModel = assistant.every(
      (message) => message.providerID === input.model.providerID && message.modelID === input.model.modelID,
    )
    return {
      costUsd: measured && Number.isFinite(measured.costUsd) ? measured.costUsd : 0,
      input: measured?.input ?? 0,
      output: measured?.output ?? 0,
      reasoning: measured?.reasoning ?? 0,
      cacheRead: measured?.cacheRead ?? 0,
      cacheWrite: measured?.cacheWrite ?? 0,
      ...(!measured && !unused ? { usageMissing: true } : {}),
      kind:
        (!measured && !unused) || incomplete || (measured !== undefined && !Number.isFinite(measured.costUsd))
          ? "unknown"
          : sameModel
            ? input.model.costKind
            : (measured?.costUsd ?? 0) > 0
              ? "priced"
              : "unknown",
      model: sameModel ? `${input.model.providerID}/${input.model.modelID}` : "Multiple models",
    } satisfies ReviewCost
  })

  const checkpoint = Effect.fnUntraced(function* () {
    const save = input.onCheckpoint
    if (!save) return
    const spent = yield* measure()
    yield* Effect.tryPromise(() => save(spent)).pipe(Effect.ignore)
  })

  // One session: the prompt, and when it was stopped or returned nothing usable, a finalize prompt in the same
  // session with every tool but StructuredOutput denied.
  function ask<T>(spec: Spec<T>): Effect.Effect<Asked<T>> {
    return Effect.gen(function* () {
      // Include the structured-output schema and a fixed context allowance. The first turn has no reported usage
      // yet, so this is only an admission estimate; provider usage replaces it as soon as it arrives.
      const context = Math.ceil((spec.text.length + JSON.stringify(spec.schema).length) / 3.5)
      const firstCost = nextCost({ context, cached: 0 })
      if (!reserve(spec.name, firstCost, firstCost))
        return { name: spec.name, status: "stopped", stop: "budget", detail: "budget", steps: 0 } satisfies Asked<T>
      const session = yield* sessions.create({
        title: `Vectorscope review · ${input.head.slice(0, 7)} · ${spec.name}`,
        permission: rules,
      })
      const track: Track = {
        name: spec.name,
        sessionID: session.id,
        cap: spec.cap,
        steps: 0,
        seen: new Set(),
        context,
        cached: 0,
        attempts: 0,
        finalizeAttempts: 0,
        finalizing: false,
        denied: false,
      }
      tracks.set(session.id, track)
      sessionIDs.push(session.id)
      yield* progress({ type: "specialist", name: spec.name, status: "running" })

      // One policy survives every processor instance, retry and prompt for this fresh owned session. It is never
      // rebuilt at a continuation boundary, and the finalizer gets exactly one separately reserved invocation.
      const policy: SessionAdmission.Policy = {
        sessionID: session.id,
        admit: (request) => {
          const stop = track.finalizing
            ? track.finalizeAttempts >= 1 || !request.tools.includes("StructuredOutput")
              ? "steps"
              : undefined
            : track.attempts >= track.cap
              ? "steps"
              : Date.now() >= deadline
                ? "timeout"
                : undefined
          if (stop) {
            track.stop ??= stop
            track.denied = true
            return
          }
          const estimate = nextCost(track)
          if (!reserve(track.name, estimate, track.finalizing ? 0 : estimate)) {
            track.stop = "budget"
            track.denied = true
            return
          }
          if (track.finalizing) track.finalizeAttempts++
          else track.attempts++
          return {
            ...(track.finalizing ? { tools: ["StructuredOutput"] } : {}),
            observe: (cost) => {
              const reservation = reservations.get(track.name)
              if (reservation) reservation.turn = Math.max(reservation.turn, cost)
            },
            settle: (result) => {
              state.spent += result.cost
              if (price && !result.complete) {
                // No usage, partial usage, and unpriced usage cannot turn an accepted attempt into free capacity.
                state.uncertain += Math.max(
                  0,
                  Math.max(estimate, reservations.get(track.name)?.turn ?? 0) - result.cost,
                )
                state.incomplete = true
              }
              track.context = result.complete ? result.context : Math.max(track.context, result.context)
              track.cached = result.complete ? result.cached : 0
              if (price) reservations.set(track.name, { turn: 0, finalize: track.finalizing ? 0 : nextCost(track) })
            },
          }
        },
      }

      const send = (text: string, ms: number): Effect.Effect<Sent> =>
        Effect.suspend(() => {
          if (ms <= 0) return Effect.succeed<Sent>({ timedOut: true })
          return prompts
            .prompt({
              sessionID: session.id,
              agent: spec.name === "security" ? "security" : "review",
              model: { providerID: input.model.providerID, modelID: input.model.modelID },
              ...(input.model.variant ? { variant: input.model.variant } : {}),
              // A class instance: the stored user message only accepts the schema class, not a plain object.
              format: new SessionV1.OutputFormatJsonSchema({ type: "json_schema", schema: spec.schema, retryCount: 0 }),
              parts: [{ type: "text", text }],
            })
            .pipe(
              Effect.provideService(SessionAdmission.Current, policy),
              Effect.timeoutOption(Duration.millis(ms)),
              Effect.exit,
              Effect.flatMap((exit): Effect.Effect<Sent> => {
                if (Exit.isFailure(exit)) return Effect.succeed({ timedOut: false })
                if (Option.isNone(exit.value))
                  return prompts.cancel(session.id).pipe(Effect.as({ timedOut: true as const }))
                return Effect.succeed({ timedOut: false, message: exit.value.value })
              }),
            )
        }).pipe(Effect.ensuring(prompts.cancel(session.id)))
      const done = (value: T | undefined, status: Asked<T>["status"], stop?: Stop, detail?: string): Asked<T> => ({
        name: spec.name,
        sessionID: session.id,
        ...(value !== undefined ? { value } : {}),
        status,
        ...(stop ? { stop } : {}),
        steps: track.steps,
        ...(detail ? { detail } : {}),
      })

      const first = yield* send(spec.text, deadline - Date.now())
      if (first.timedOut) track.stop ??= "timeout"
      const message = first.timedOut ? undefined : first.message
      const structured = message?.info.role === "assistant" ? message.info.structured : undefined
      // The report came back whole; a stop that landed after its last step changes nothing.
      const value =
        structured !== undefined ? spec.decode(structured) : !track.stop ? spec.decode(lastText(message)) : undefined
      if (value !== undefined) return done(value, "ok")

      // The first prompt is now idle. Unknown exposure stays in the review's ledger; only unused future work is
      // released. The finalizer must still fit beside every other specialist's admitted work.
      if (!reserve(track.name, nextCost(track), 0)) return done(undefined, "stopped", "budget", "budget")
      track.finalizing = true
      track.denied = false
      yield* sessions.setPermission({ sessionID: session.id, permission: [...rules, DENY_ALL, ALLOW_OUTPUT] })
      const last = yield* send(buildFinalizePrompt(), FINALIZE_MS)
      const final = last.timedOut ? undefined : last.message
      const finalStructured = final?.info.role === "assistant" ? final.info.structured : undefined
      const finalValue = spec.decode(finalStructured !== undefined ? finalStructured : lastText(final))
      if (finalValue === undefined && track.denied) return done(undefined, "stopped", track.stop, track.stop)
      if (finalValue === undefined)
        return done(undefined, "failed", track.stop, errorOf(final) ?? errorOf(message) ?? "no report")
      const status = track.stop === "timeout" ? "timeout" : track.stop ? "stopped" : "ok"
      return done(finalValue, status, track.stop, track.stop)
    }).pipe(
      Effect.ensuring(Effect.sync(() => reservations.delete(spec.name))),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.succeed<Asked<T>>({
            name: spec.name,
            status: "failed",
            steps: 0,
            detail: Cause.prettyErrors(cause)[0]?.message ?? "the session failed",
          }),
      ),
      Effect.tap((done) => progress({ type: "specialist", name: done.name, status: done.status })),
      Effect.tap(() => checkpoint()),
    )
  }

  const body = Effect.gen(function* () {
    // Prompts: the diff that fits the model's context, focus files first in incremental mode.
    const focused = new Set((input.focus ?? []).map((hunk) => hunk.path))
    const ordered =
      input.mode === "incremental"
        ? [
            ...input.files.filter((file) => focused.has(file.path)),
            ...input.files.filter((file) => !focused.has(file.path)),
          ]
        : input.files
    const split = budgetDiff(ordered, diffBudgetChars(input.model.context, config.maxDiffChars))
    const promptInput: PromptInput = {
      mode: input.mode,
      trust: input.trust,
      base: input.base,
      head: input.head,
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      ...(input.since ? { since: input.since } : {}),
      ...(input.pr ? { pr: input.pr } : {}),
      diff: renderPatch(split.inline),
      notInlined: split.notInlined.map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
      })),
      ...(input.focus ? { focus: input.focus } : {}),
      ...(input.headFiles ? { headFiles: input.headFiles } : {}),
      ...input.context,
      rules: input.rules,
      rulesSource:
        input.rulesSource ??
        (input.trigger === "local" || input.trigger === "desktop" ? "working tree" : "base branch"),
      prior: input.prior,
      maxComments: config.maxComments,
    }

    // 1–5. The specialists, in parallel, one session each.
    const asked = yield* Effect.forEach(
      planSpecialists(input.files, config),
      (name) =>
        ask({
          name,
          cap: name === "security" ? Math.ceil((config.maxSteps * 2) / 3) : config.maxSteps,
          text: name === "security" ? buildSecurityPrompt(promptInput) : buildReviewPrompt(promptInput),
          schema: REVIEW_REPORT_JSON_SCHEMA,
          decode: decodeReport,
        }),
      { concurrency: 2 },
    )

    // 6. Normalize.
    const reports = asked.flatMap((entry) =>
      entry.value
        ? [{ source: entry.name === "security" ? ("security" as const) : ("review" as const), report: entry.value }]
        : [],
    )
    const report = mergeReports(reports.map((entry) => entry.report))
    const normalized = reports.flatMap((entry) => normalizeFindings(entry.report.findings, entry.source, input.anchors))

    // 7. Verify: blocking findings (and every suggestion when untrusted), or everything of concern or above.
    const candidates = [
      ...new Map(
        (config.verify === "off" ? [] : normalized)
          .filter((finding) =>
            config.verify === "all"
              ? finding.severity !== "nit" && finding.confidence >= config.minConfidence
              : (finding.severity === "blocking" && finding.confidence >= config.minConfidence) ||
                (input.trust === "untrusted" && finding.suggestion !== undefined),
          )
          .map((finding) => [finding.id, finding]),
      ).values(),
    ]
    const verifyText = candidates.length
      ? buildVerifyPrompt({ trust: input.trust, head: input.head, candidates, headFiles: input.headFiles })
      : ""
    const estimate = price
      ? estimateCostUsd({ promptTokens: Math.ceil(verifyText.length / 3.5), maxSteps: VERIFY_STEPS, price }).low
      : 0
    const unaffordable = price !== undefined && state.spent + state.uncertain + estimate > config.maxCostUsd
    const late = deadline - Date.now() < VERIFY_MIN_MS
    const verify: Asked<ReturnType<typeof decodeVerify>> | undefined = !candidates.length
      ? undefined
      : unaffordable || late
        ? { name: "verify", status: "skipped", steps: 0, detail: unaffordable ? "budget" : "time" }
        : yield* ask({
            name: "verify",
            cap: VERIFY_STEPS,
            text: verifyText,
            schema: VERIFY_JSON_SCHEMA,
            decode: decodeVerify,
          })
    const verdicts = new Map((verify?.value ?? []).map((entry) => [entry.id, entry.verdict]))
    const findings = normalized
      .filter((finding) => verdicts.get(finding.id) !== "rejected")
      .map((finding) => (verdicts.get(finding.id) === "confirmed" ? { ...finding, verified: true } : finding))
    const rejected = normalized.length - findings.length

    // 8. Select. Paths outside the diff are checked against the repository first; selection is synchronous.
    const index = buildAnchorIndex(input.anchors)
    const outside = [...new Set(findings.map((finding) => finding.path))].filter((file) => !lookupFile(index, file))
    const known = new Map(
      yield* Effect.forEach(outside, (file) =>
        Effect.tryPromise(() => input.knownPath(file)).pipe(
          Effect.catch(() => Effect.succeed(false)),
          Effect.map((found) => [file, found] as const),
        ),
      ),
    )
    const skipped = new Set(input.skipped.map((file) => file.path))
    const selection = selectFindings({
      findings,
      anchors: input.anchors,
      head: input.head,
      trust: input.trust,
      mode: input.mode,
      config,
      prior: input.prior,
      ...(input.focus ? { focus: input.focus } : {}),
      inlinePosted: input.inlinePosted ?? 0,
      ignored: (file) => skipped.has(file) || classifyPath(file, { config }) !== undefined,
      knownPath: (file) => known.get(file) ?? true,
      teamDismissed: input.context.teamDismissed,
      dropped: rejected ? [{ reason: "rejected-by-verify", count: rejected }] : [],
      modelRisk: report.risk,
      sensitiveChanged: input.files.some((file) => isSensitivePath(file.path)),
      changedLines: input.files.reduce((sum, file) => sum + file.additions + file.deletions, 0),
    })

    // A partial run records the files no finished specialist saw, so the next run reviews them. A run where no
    // specialist finished leaves every file unreviewed.
    const partial =
      asked.find((entry) => entry.stop)?.stop ??
      (asked.some((entry) => !entry.value) ? ("model-error" as const) : undefined)
    const unreviewed =
      !reports.length || asked.some((entry) => entry.stop && !entry.value)
        ? input.files.map((file) => file.path)
        : partial && partial !== "model-error"
          ? yield* uncovered(asked.flatMap((entry) => (entry.value && entry.sessionID ? [entry.sessionID] : [])))
          : []

    function uncovered(ids: SessionID[]) {
      return Effect.gen(function* () {
        const covered = new Set([
          ...split.inline.map((file) => file.path),
          ...report.files.map((file) => file.path),
          ...report.findings.map((finding) => finding.path),
        ])
        const messages = yield* Effect.forEach(ids, (id) =>
          sessions.messages({ sessionID: id }).pipe(Effect.catch(() => Effect.succeed([]))),
        )
        for (const part of messages.flat().flatMap((message) => message.parts)) {
          if (part.type !== "tool" || part.tool !== "read") continue
          const read = part.state.input["filePath"]
          if (typeof read === "string") covered.add(path.isAbsolute(read) ? path.relative(input.directory, read) : read)
        }
        return input.files.map((file) => file.path).filter((file) => !covered.has(file))
      })
    }

    return {
      report,
      selection,
      skipped: input.skipped,
      cost: yield* measure(),
      durationMs: Date.now() - started,
      base: input.base,
      head: input.head,
      ...(input.since ? { since: input.since } : {}),
      mode: input.mode,
      ...(partial ? { partial } : {}),
      unreviewed,
      specialists: [...asked, ...(verify ? [verify] : [])].map((entry) => ({
        name: entry.name,
        status: entry.status,
        steps: entry.steps,
        ...(entry.detail ? { detail: entry.detail } : {}),
      })),
      sessions: [...sessionIDs],
      stats: {
        files: input.files.length,
        additions: input.files.reduce((sum, file) => sum + file.additions, 0),
        deletions: input.files.reduce((sum, file) => sum + file.deletions, 0),
      },
      notes: [
        ...(verify?.status === "skipped" ? [noteVerifySkipped()] : []),
        ...(state.incomplete
          ? [
              "Reported cost may be incomplete; work with uncertain usage retained its estimated budget exposure for this review.",
            ]
          : []),
      ],
    } satisfies ReviewOutcome
  })

  return yield* body.pipe(Effect.ensuring(unsubscribe.pipe(Effect.andThen(Scope.close(scope, Exit.void)))))
})

// A finding's id is its fingerprint over the path, category, title words and the code it is anchored to, so the
// same finding keeps its id when lines shift or the title's words are reordered.
export function normalizeFindings(findings: ModelFinding[], source: Finding["source"], anchors: DiffFile[]): Finding[] {
  const index = buildAnchorIndex(anchors)
  return findings.map((finding) => {
    const side = finding.side ?? "RIGHT"
    const file = lookupFile(index, finding.path)?.file.path ?? finding.path
    const anchored = resolveAnchor(index, { ...finding, side })
    const code = anchored.ok ? anchorText(index, anchored.anchor) : ""
    return {
      ...finding,
      path: file,
      side,
      source,
      id: fingerprint(file, finding.category, normalizeTitle(finding.title), normalizeCode(code)),
    }
  })
}

function lastText(message: SessionV1.WithParts | undefined) {
  return message?.parts.findLast((part) => part.type === "text")?.text ?? ""
}

function errorOf(message: SessionV1.WithParts | undefined) {
  const error = message?.info.role === "assistant" ? message.info.error : undefined
  if (!error) return undefined
  const data: { message?: unknown } | undefined = error.data
  return typeof data?.message === "string" ? `${error.name}: ${data.message}` : error.name
}

// The review's summary and file notes lead; the security specialist's findings and notes are added to them.
function mergeReports(reports: ModelReport[]): ModelReport {
  const rank: Risk[] = ["low", "medium", "high"]
  const files = new Map(
    reports
      .flatMap((report) => report.files)
      .toReversed()
      .map((entry) => [entry.path, entry.note]),
  )
  const prior = new Map(
    reports
      .flatMap((report) => report.priorStatus ?? [])
      .toReversed()
      .map((entry) => [entry.id, entry]),
  )
  return {
    summary: reports.find((report) => report.summary.trim())?.summary ?? "",
    risk: reports.reduce<Risk>(
      (risk, report) => (rank.indexOf(report.risk) > rank.indexOf(risk) ? report.risk : risk),
      "low",
    ),
    files: [...files].toReversed().map(([file, note]) => ({ path: file, note })),
    findings: reports.flatMap((report) => report.findings),
    ...(prior.size ? { priorStatus: [...prior.values()].toReversed() } : {}),
  }
}

export * as Review from "./run"
