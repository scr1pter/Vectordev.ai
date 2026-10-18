import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/memory"

export const MemoryListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(BrainSchema.Scope),
  filter: Schema.optional(Schema.Literals(["active", "review", "archived", "all"])),
  query: Schema.optional(Schema.String),
})

export const MemoryStats = Schema.Struct({
  active: Schema.Number,
  review: Schema.Number,
  archived: Schema.Number,
  rules: Schema.Number,
  learned: Schema.Number,
  digestTokens: Schema.Number,
  learning: Schema.Boolean,
}).annotate({ identifier: "MemoryStats" })

export const MemoryList = Schema.Struct({
  entries: Schema.Array(BrainSchema.Entry),
  stats: MemoryStats,
  // The files Vector reads memory from, so the page can say where an entry lives and how to change it.
  files: Schema.Struct({
    memory: Schema.String,
    rules: Schema.String,
    repository: Schema.Array(Schema.String),
  }),
  // The repository's own memory waits for review while its settings are not trusted.
  held: Schema.Boolean,
}).annotate({ identifier: "MemoryList" })

export const MemoryDetail = Schema.Struct({
  entry: BrainSchema.Entry,
  evidence: Schema.Array(BrainSchema.Evidence),
  related: Schema.Array(BrainSchema.Entry),
}).annotate({ identifier: "MemoryDetail" })

export const MemoryCreatePayload = Schema.Struct({
  kind: BrainSchema.LearnedKind,
  text: Schema.String,
  scope: BrainSchema.Scope,
})

export const MemoryUpdatePayload = Schema.Struct({
  text: Schema.optional(Schema.String),
  pinned: Schema.optional(Schema.Boolean),
  action: Schema.optional(Schema.Literals(["approve", "reject", "archive", "restore"])),
})

export const MemoryErasePayload = Schema.Struct({
  scope: Schema.Literals(["repository", "personal", "all"]),
})

export const MemorySettings = Schema.Struct({
  learning: Schema.Boolean,
}).annotate({ identifier: "MemorySettings" })

export const MemoryTidy = Schema.Struct({
  merged: Schema.Number,
  promoted: Schema.Number,
  archived: Schema.Number,
  dropped: Schema.Number,
  stale: Schema.Number,
}).annotate({ identifier: "MemoryTidy" })

export class MemoryApiError extends Schema.ErrorClass<MemoryApiError>("MemoryError")(
  {
    name: Schema.Literal("MemoryError"),
    data: Schema.Struct({
      code: Schema.Literals(["refused", "not-found"]),
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

const MemoryID = Schema.String.annotate({ description: "A memory entry's short id, such as m4k2q" })

// Memory is the owner's own: every route is owner-only (ServerAuth), and a guest never reads it.
export const MemoryApi = HttpApi.make("memory")
  .add(
    HttpApiGroup.make("memory")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: MemoryListQuery,
          success: described(MemoryList, "Memory entries for this repository and the user"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.list",
            summary: "List memory",
            description:
              "Rules, saved preferences and what Vector learned for the repository at `directory` and for the user, with counts.",
          }),
        ),
        HttpApiEndpoint.get("get", `${root}/:memoryID`, {
          params: { memoryID: MemoryID },
          query: WorkspaceRoutingQuery,
          success: described(MemoryDetail, "One memory entry with its evidence"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.get",
            summary: "Get a memory entry",
            description: "One entry, the evidence it was saved with, and related entries.",
          }),
        ),
        HttpApiEndpoint.post("create", root, {
          query: WorkspaceRoutingQuery,
          payload: MemoryCreatePayload,
          success: described(BrainSchema.Entry, "The saved entry"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.create",
            summary: "Add a memory",
            description: "Save something for Vector to remember, as the user. Secrets are refused.",
          }),
        ),
        HttpApiEndpoint.patch("update", `${root}/:memoryID`, {
          params: { memoryID: MemoryID },
          query: WorkspaceRoutingQuery,
          payload: MemoryUpdatePayload,
          success: described(BrainSchema.Entry, "The entry after the change"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.update",
            summary: "Change a memory entry",
            description: "Edit, pin or unpin, approve or reject a held entry, archive or restore.",
          }),
        ),
        HttpApiEndpoint.delete("remove", `${root}/:memoryID`, {
          params: { memoryID: MemoryID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "The entry was forgotten"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.remove",
            summary: "Forget a memory entry",
            description:
              "Delete an entry for good. Vector keeps only a hash of its text so it does not learn it again. Entries from a file are changed in the file.",
          }),
        ),
        HttpApiEndpoint.post("erase", `${root}/erase`, {
          query: WorkspaceRoutingQuery,
          payload: MemoryErasePayload,
          success: described(Schema.Number, "How many entries were erased"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.erase",
            summary: "Erase learned memory",
            description:
              "Erase what Vector learned for this repository, for the user, or everywhere. Files people wrote are left alone.",
          }),
        ),
        HttpApiEndpoint.post("tidy", `${root}/tidy`, {
          query: WorkspaceRoutingQuery,
          success: described(MemoryTidy, "What tidying changed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.tidy",
            summary: "Tidy memory now",
            description: "Merge duplicates, confirm or drop proposals, archive what goes unused and mark stale entries.",
          }),
        ),
        HttpApiEndpoint.get("settings", `${root}/settings`, {
          query: WorkspaceRoutingQuery,
          success: described(MemorySettings, "Memory settings"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.settings.get",
            summary: "Get memory settings",
            description: "Whether Vector may add to its memory as it works.",
          }),
        ),
        HttpApiEndpoint.patch("configure", `${root}/settings`, {
          query: WorkspaceRoutingQuery,
          payload: MemorySettings,
          success: described(MemorySettings, "Memory settings after the change"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.settings.update",
            summary: "Change memory settings",
            description: "Turn Vector's learning on or off. Memory already saved stays until you erase it.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "memory",
          description: "Vector's memory: rules, saved preferences and what Vector learned, kept on this computer.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "vector HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
