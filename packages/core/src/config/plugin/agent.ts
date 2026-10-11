export * as ConfigAgentPlugin from "./agent"

import { define } from "../../plugin/internal"
import path from "path"
import { Effect, Option, Schema } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { ConfigAgent } from "../agent"
import { ConfigMarkdown } from "../markdown"
import { FSUtil } from "../../fs-util"
import { ModelV2 } from "../../model"
import { ConfigAgentV1 } from "../../v1/config/agent"
import { ConfigMigrateV1 } from "../../v1/config/migrate"

const legacySources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info)
const decodeLegacyAgent = Schema.decodeUnknownOption(ConfigAgentV1.Info)
const decodeConfig = Schema.decodeUnknownOption(Config.Info)
const agentKeys = new Set([
  "model",
  "variant",
  "request",
  "system",
  "description",
  "mode",
  "hidden",
  "color",
  "steps",
  "disabled",
  "permissions",
])

export const Plugin = define({
  id: "config-agent",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    yield* ctx.agent.transform(
      Effect.fn(function* (draft) {
        const documents = yield* Effect.forEach(yield* config.entries(), (entry) => {
          if (config.executable?.(entry) === false) return Effect.succeed([])
          const scope = config.scope?.(entry) ?? "global"
          if (entry.type === "document") return Effect.succeed([{ document: entry, scope }])
          return Effect.gen(function* () {
            const files = yield* discover(fs, entry.path)
            return yield* Effect.forEach(files, (file) =>
              fs.readFileStringSafe(file.filepath).pipe(
                Effect.map((content) => content && decode(file, content)),
                Effect.catch(() => Effect.succeed(undefined)),
              ),
            ).pipe(
              Effect.map((documents) =>
                documents
                  .filter((document): document is Config.Document => document !== undefined)
                  .map((document) => ({ document, scope })),
              ),
            )
          })
        }).pipe(Effect.map((documents) => documents.flat()))
        const permissions = documents.flatMap((item) => item.document.info.permissions ?? [])
        const globalDenials = documents
          .filter((item) => item.scope === "global")
          .flatMap((item) => item.document.info.permissions ?? [])
          .filter((rule) => rule.effect === "deny")
        const hasProjectOverrides = documents.some(
          (item) =>
            item.scope === "project" && item.document.info.permissions?.some((rule) => rule.effect !== "deny") === true,
        )
        const configuredDefault = Config.latest(
          documents.map((item) => item.document),
          "default_agent",
        )
        if (configuredDefault !== undefined) draft.default(AgentV2.ID.make(configuredDefault))
        for (const current of draft.list()) {
          draft.update(current.id, (agent) => agent.permissions.push(...permissions))
        }

        for (const source of documents) {
          const document = source.document
          for (const [id, item] of Object.entries(document.info.agents ?? {})) {
            const agentID = AgentV2.ID.make(id)
            if (item.disabled) {
              draft.remove(agentID)
              continue
            }

            const exists = draft.get(agentID) !== undefined
            draft.update(agentID, (agent) => {
              if (!exists) agent.permissions.push(...permissions)
              if (item.model !== undefined) {
                const model = ModelV2.parse(item.model)
                agent.model = { id: model.modelID, providerID: model.providerID, variant: agent.model?.variant }
              }
              if (item.variant !== undefined && agent.model !== undefined) {
                agent.model.variant = ModelV2.VariantID.make(item.variant)
              }
              if (item.request !== undefined) {
                Object.assign(agent.request.headers, item.request.headers ?? {})
                Object.assign(agent.request.body, item.request.body ?? {})
              }
              if (item.system !== undefined) agent.system = item.system
              if (item.description !== undefined) agent.description = item.description
              if (item.mode !== undefined) agent.mode = item.mode
              if (item.hidden !== undefined) agent.hidden = item.hidden
              if (item.color !== undefined) agent.color = item.color
              if (item.steps !== undefined) agent.steps = item.steps
              if (item.permissions !== undefined) agent.permissions.push(...item.permissions)
            })
          }
        }

        // Flat agent rules cannot retain trust tiers, so replay global denials after project overrides.
        for (const current of draft.list()) {
          const hasProjectAgentOverrides = documents.some(
            (item) =>
              item.scope === "project" &&
              item.document.info.agents?.[current.id]?.permissions?.some((rule) => rule.effect !== "deny") === true,
          )
          if (!hasProjectOverrides && !hasProjectAgentOverrides) continue
          const denials = [
            ...globalDenials,
            ...documents
              .filter((item) => item.scope === "global")
              .flatMap((item) => item.document.info.agents?.[current.id]?.permissions ?? [])
              .filter((rule) => rule.effect === "deny"),
          ]
          if (denials.length === 0) continue
          draft.update(current.id, (agent) => agent.permissions.push(...denials))
        }
      }),
    )
  }),
})

function discover(fs: FSUtil.Interface, directory: string) {
  return Effect.forEach(legacySources, (source) =>
    fs
      .glob(source.pattern, { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(
        Effect.map((files) => files.toSorted().map((filepath) => ({ directory, filepath, primary: source.primary }))),
      ),
  ).pipe(
    Effect.map((files) => files.flat()),
    Effect.catch(() => Effect.succeed([])),
  )
}

function decode(file: { directory: string; filepath: string; primary: boolean }, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const name = path
    .relative(file.directory, file.filepath)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents|mode|modes)\//, "")
    .replace(/\.md$/, "")
  const body = markdown.content.trim()
  const legacy = Object.keys(markdown.data).some((key) => !agentKeys.has(key))
  const agent = Option.getOrUndefined(
    legacy
      ? Option.map(
          decodeLegacyAgent({ name, ...markdown.data, prompt: body }, { errors: "all", propertyOrder: "original" }),
          ConfigMigrateV1.migrateAgent,
        )
      : decodeAgent({ ...markdown.data, system: body }, { errors: "all", propertyOrder: "original" }),
  )
  if (!agent) return
  const info = Option.getOrUndefined(
    decodeConfig({
      agents: { [name]: file.primary ? { ...agent, mode: "primary" } : agent },
    }),
  )
  if (!info) return
  return new Config.Document({ type: "document", path: file.filepath, info })
}
