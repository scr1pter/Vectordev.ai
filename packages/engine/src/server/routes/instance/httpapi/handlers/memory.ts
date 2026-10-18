import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Brain } from "@vectordevai/core/brain/brain"
import { Instruction } from "@/session/instruction"
import { InstanceHttpApi } from "../api"
import { MemoryApiError } from "../groups/memory"

const refused = (message: string) => new MemoryApiError({ name: "MemoryError", data: { code: "refused", message } })
const missing = (id: string) =>
  new MemoryApiError({ name: "MemoryError", data: { code: "not-found", message: `No memory ${id} here.` } })

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const brain = yield* Brain.Service
    const instruction = yield* Instruction.Service

    const list = Effect.fn("MemoryHttpApi.list")(function* (ctx: {
      query: { scope?: "repository" | "personal"; filter?: "active" | "review" | "archived" | "all"; query?: string }
    }) {
      const place = yield* instruction.place()
      const entries = yield* brain.list(place, {
        ...(ctx.query.filter ? { filter: ctx.query.filter } : {}),
        ...(ctx.query.query ? { query: ctx.query.query } : {}),
        ...(ctx.query.scope ? { scope: ctx.query.scope } : {}),
      })
      return {
        entries,
        stats: yield* brain.stats(place),
        files: { ...brain.files(), repository: place.sources.map((source) => source.path) },
        held: place.held,
      }
    })

    const get = Effect.fn("MemoryHttpApi.get")(function* (ctx: { params: { memoryID: string } }) {
      const detail = yield* brain.get(yield* instruction.place(), ctx.params.memoryID, { personal: true })
      if (!detail) return yield* missing(ctx.params.memoryID)
      return detail
    })

    const create = Effect.fn("MemoryHttpApi.create")(function* (ctx: {
      payload: { kind: "preference" | "decision" | "lesson" | "fact"; text: string; scope: "repository" | "personal" }
    }) {
      const result = yield* brain.propose(yield* instruction.place(), {
        kind: ctx.payload.kind,
        text: ctx.payload.text,
        scope: ctx.payload.scope,
        origin: "user",
        evidence: { type: "user" },
      })
      if (result.type === "refused") return yield* refused(result.message)
      return result.entry
    })

    const update = Effect.fn("MemoryHttpApi.update")(function* (ctx: {
      params: { memoryID: string }
      payload: { text?: string; pinned?: boolean; action?: "approve" | "reject" | "archive" | "restore" }
    }) {
      const result = yield* brain.update(yield* instruction.place(), ctx.params.memoryID, ctx.payload, "user")
      if (!result) return yield* missing(ctx.params.memoryID)
      if (result.type === "refused") return yield* refused(result.message)
      return result.entry
    })

    const remove = Effect.fn("MemoryHttpApi.remove")(function* (ctx: { params: { memoryID: string } }) {
      const result = yield* brain.forget(yield* instruction.place(), ctx.params.memoryID)
      if (result === "not-found") return yield* missing(ctx.params.memoryID)
      if (result === "file-entry") return yield* refused("This entry comes from a file you wrote; change it in that file.")
      return true
    })

    const erase = Effect.fn("MemoryHttpApi.erase")(function* (ctx: {
      payload: { scope: "repository" | "personal" | "all" }
    }) {
      return yield* brain.erase(yield* instruction.place(), ctx.payload.scope)
    })

    const tidy = Effect.fn("MemoryHttpApi.tidy")(function* () {
      const report = yield* brain.consolidate(yield* instruction.place(), { force: true })
      return {
        merged: report.merged,
        promoted: report.promoted,
        archived: report.archived,
        dropped: report.dropped,
        stale: report.stale,
      }
    })

    const settings = Effect.fn("MemoryHttpApi.settings")(function* () {
      return { learning: yield* brain.learning() }
    })

    const configure = Effect.fn("MemoryHttpApi.configure")(function* (ctx: { payload: { learning: boolean } }) {
      yield* brain.setLearning(ctx.payload.learning)
      return { learning: yield* brain.learning() }
    })

    return handlers
      .handle("list", list)
      .handle("get", get)
      .handle("create", create)
      .handle("update", update)
      .handle("remove", remove)
      .handle("erase", erase)
      .handle("tidy", tidy)
      .handle("settings", settings)
      .handle("configure", configure)
  }),
)
