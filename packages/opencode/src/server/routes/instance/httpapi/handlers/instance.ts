import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@opencode-ai/core/global"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { InstanceHttpApi } from "../api"
import { ApiVcsApplyError, ApiVcsCommitError } from "../groups/instance"
import { markInstanceForDisposal } from "../lifecycle"

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const skill = yield* Skill.Service
    const vcs = yield* Vcs.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
        concurrency: "unbounded",
      })
      return { branch, default_branch }
    })

    const getVcsStatus = Effect.fn("InstanceHttpApi.vcsStatus")(function* () {
      return yield* vcs.status()
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: {
      query: { mode: Vcs.Mode; context?: number }
    }) {
      return yield* vcs.diff(ctx.query.mode, { context: ctx.query.context })
    })

    const getVcsDiffRaw = Effect.fn("InstanceHttpApi.vcsDiffRaw")(function* () {
      return yield* vcs.diffRaw()
    })

    const applyVcs = Effect.fn("InstanceHttpApi.vcsApply")(function* (ctx: { payload: Vcs.ApplyInput }) {
      return yield* vcs.apply(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsApplyError({
              name: "VcsApplyError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    const commitVcs = Effect.fn("InstanceHttpApi.vcsCommit")(function* (ctx: { payload: Vcs.CommitInput }) {
      return yield* vcs.commit(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsCommitError({
              name: "VcsCommitError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      return yield* command.list()
    })

    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      return yield* agent.list()
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      return yield* skill.all()
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const resolveLspFile = Effect.fnUntraced(function* (file: string) {
      const directory = yield* InstanceState.directory
      return path.resolve(directory, file)
    })

    const lspDiagnostics = Effect.fn("InstanceHttpApi.lspDiagnostics")(function* (ctx: {
      payload: { file: string }
    }) {
      const file = yield* resolveLspFile(ctx.payload.file)
      yield* lsp.touchFile(file, "document")
      const diagnostics = yield* lsp.diagnostics()
      return (diagnostics[file] ?? []).map((item) => ({
        range: item.range,
        severity: item.severity,
        code: item.code === undefined ? undefined : String(item.code),
        source: item.source,
        message: item.message,
      }))
    })

    const lspHover = Effect.fn("InstanceHttpApi.lspHover")(function* (ctx: { payload: LSP.Request }) {
      const raw = yield* lsp.hover({ ...ctx.payload, file: yield* resolveLspFile(ctx.payload.file) })
      return normalizeHover(raw)
    })

    const lspDefinition = Effect.fn("InstanceHttpApi.lspDefinition")(function* (ctx: {
      payload: LSP.Request
    }) {
      return normalizeLocations(
        yield* lsp.definition({ ...ctx.payload, file: yield* resolveLspFile(ctx.payload.file) }),
      )
    })

    const lspReferences = Effect.fn("InstanceHttpApi.lspReferences")(function* (ctx: {
      payload: LSP.Request
    }) {
      return normalizeLocations(
        yield* lsp.references({ ...ctx.payload, file: yield* resolveLspFile(ctx.payload.file) }),
      )
    })

    const lspSymbols = Effect.fn("InstanceHttpApi.lspSymbols")(function* (ctx: {
      payload: { file: string }
    }) {
      const file = yield* resolveLspFile(ctx.payload.file)
      yield* lsp.touchFile(file)
      return yield* lsp.documentSymbol(pathToFileURL(file).href)
    })

    const lspRename = Effect.fn("InstanceHttpApi.lspRename")(function* (ctx: {
      payload: LSP.RenameRequest
    }) {
      const result = lsp.rename
        ? yield* lsp.rename({
            ...ctx.payload,
            file: yield* resolveLspFile(ctx.payload.file),
          })
        : []
      return { files: normalizeWorkspaceEdits(result) }
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsStatus", getVcsStatus)
      .handle("vcsDiff", getVcsDiff)
      .handle("vcsDiffRaw", getVcsDiffRaw)
      .handle("vcsApply", applyVcs)
      .handle("vcsCommit", commitVcs)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("skill", getSkill)
      .handle("lsp", getLsp)
      .handle("lspDiagnostics", lspDiagnostics)
      .handle("lspHover", lspHover)
      .handle("lspDefinition", lspDefinition)
      .handle("lspReferences", lspReferences)
      .handle("lspSymbols", lspSymbols)
      .handle("lspRename", lspRename)
      .handle("formatter", getFormatter)
  }),
)

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function position(value: unknown): LSP.Position | undefined {
  const item = record(value)
  if (!item || typeof item.line !== "number" || typeof item.character !== "number") return
  return { line: item.line, character: item.character }
}

function range(value: unknown): LSP.Range | undefined {
  const item = record(value)
  const start = position(item?.start)
  const end = position(item?.end)
  if (!start || !end) return
  return { start, end }
}

function normalizeLocations(value: unknown): LSP.Location[] {
  const items = Array.isArray(value) ? value.flat(Infinity) : [value]
  return items.flatMap((entry) => {
    const item = record(entry)
    if (!item) return []
    const uri = typeof item.uri === "string" ? item.uri : typeof item.targetUri === "string" ? item.targetUri : undefined
    const targetRange = range(item.range) ?? range(item.targetSelectionRange) ?? range(item.targetRange)
    if (!uri || !targetRange) return []
    return [{ uri, range: targetRange }]
  })
}

function hoverText(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(hoverText)
  const item = record(value)
  if (!item) return []
  if (typeof item.value === "string") return [item.value]
  if (typeof item.contents !== "undefined") return hoverText(item.contents)
  return []
}

function normalizeHover(value: unknown): LSP.Hover | null {
  const items = Array.isArray(value) ? value : [value]
  for (const entry of items) {
    const item = record(entry)
    if (!item) continue
    const contents = hoverText(item.contents)
    if (!contents.length) continue
    return { contents, range: range(item.range) }
  }
  return null
}

function normalizeTextEdits(value: unknown): LSP.TextEdit[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = record(entry)
    const editRange = range(item?.range)
    if (!editRange || typeof item?.newText !== "string") return []
    return [{ range: editRange, newText: item.newText }]
  })
}

function normalizeWorkspaceEdits(value: unknown): LSP.FileEdit[] {
  const files = new Map<string, LSP.TextEdit[]>()
  const results = Array.isArray(value) ? value : [value]
  const append = (uri: string, edits: LSP.TextEdit[]) => {
    if (!edits.length) return
    files.set(uri, [...(files.get(uri) ?? []), ...edits])
  }
  for (const result of results) {
    const workspace = record(result)
    const changes = record(workspace?.changes)
    if (changes) {
      for (const [uri, edits] of Object.entries(changes)) append(uri, normalizeTextEdits(edits))
    }
    if (!Array.isArray(workspace?.documentChanges)) continue
    for (const change of workspace.documentChanges) {
      const item = record(change)
      const document = record(item?.textDocument)
      if (typeof document?.uri !== "string") continue
      append(document.uri, normalizeTextEdits(item?.edits))
    }
  }
  return [...files].map(([uri, edits]) => ({ uri, edits }))
}
