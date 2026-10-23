import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocalMode } from "@vectordevai/schema/local-mode"
import { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { LocalSettings } from "@/config/local-settings"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"

// Vector Local: its settings, the network log ("What Vector sent"), finding and checking model servers, and the model
// suggestions for this computer. Every route is the server owner's (packages/server/src/auth.ts). The policy is the
// process's, not a repository's; the directory only says which repository's agents and tools a model check uses.

const root = "/local"

export class LocalApiError extends Schema.ErrorClass<LocalApiError>("LocalError")(
  {
    name: Schema.Literal("LocalError"),
    data: Schema.Struct({
      code: Schema.Literals(["agent", "locked", "invalid", "changed", "not-found"]),
      message: Schema.String,
      /** For "changed": the change that is held now, which the owner has to look at again. */
      changes: Schema.optional(Schema.Array(Schema.String)),
    }),
  },
  { httpApiStatus: 400 },
) {}

/** A change that would loosen Vector Local, sent without `confirm`: nothing was written. */
export class LocalConfirmError extends Schema.ErrorClass<LocalConfirmError>("LocalConfirmError")(
  {
    name: Schema.Literal("LocalConfirmError"),
    data: Schema.Struct({
      message: Schema.String,
      /** What the change would loosen, for the owner's dialog: "turns Vector Local off", "allows github". */
      changes: Schema.Array(Schema.String),
      /**
       * For Add server: what changed about a server already on the list since it was pinned (its kind, version,
       * models or https key), for the warning that it now answers as a different server.
       */
      identity: Schema.optional(Schema.Array(LocalProbe.Change)),
    }),
  },
  { httpApiStatus: 409 },
) {}

const Since = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

export const LocalEgressQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  /** Milliseconds since the epoch: events at or after it. */
  since: Schema.optional(Since),
  /** A session: its own events and its subagents' and helpers'. */
  session: Schema.optional(Schema.String),
  /** true: only blocked requests (and asks); false: only allowed ones. */
  blocked: Schema.optional(QueryBoolean),
})

export const LocalEgressExportQuery = Schema.Struct({
  ...LocalEgressQuery.fields,
  format: Schema.optional(Schema.Literals(["jsonl", "csv"])),
})

export const LocalSummaryQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  session: Schema.optional(Schema.String),
})

export const LocalReportPayload = Schema.Struct({
  events: Schema.Array(LocalMode.Event).check(Schema.isMaxLength(500)),
})

export const LocalDetectPayload = Schema.Struct({
  /** Ports to ask on this computer as well as the usual ones, such as a server started on another port. */
  ports: Schema.optional(
    Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))).check(Schema.isMaxLength(16)),
  ),
})

export const LocalProbePayload = Schema.Struct({
  url: Schema.String,
  /** Headers the server needs to answer, such as a company gateway's key. They are sent to that server only. */
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

export const LocalProbeResult = Schema.Struct({
  server: Schema.NullOr(LocalProbe.Server),
  /** Why nothing was read, when `server` is null. */
  message: Schema.optional(Schema.String),
}).annotate({ identifier: "LocalProbeResult" })

export const LocalAddServerPayload = Schema.Struct({
  ...LocalProbePayload.fields,
  /** The provider name to add it as. Default: its kind's, numbered when that is taken. */
  provider: Schema.optional(Schema.String),
  /** The owner confirmed putting it on the list, which loosens Vector Local while it is on. */
  confirm: Schema.optional(Schema.Boolean),
})

export const LocalAddedServer = Schema.Struct({
  provider: Schema.String,
  models: Schema.Array(Schema.String),
  server: LocalProbe.Server,
  status: LocalSettings.Status,
  /** What changed about a server already pinned since it was pinned, when it answers differently now. */
  identity: Schema.optional(Schema.Array(LocalProbe.Change)),
}).annotate({ identifier: "LocalAddedServer" })

export const LocalCheckPayload = Schema.Struct({
  /** A model to run through the requests the role makes, as provider/model. Without it, every layer is checked. */
  model: Schema.optional(Schema.String),
  /** The role the model is checked for: its tools, and the context it needs. Default: agent. */
  role: Schema.optional(LocalSettings.Role),
  /** The owner accepted the warning that the model may not fit in free memory. */
  confirmed: Schema.optional(Schema.Boolean),
})

export const LocalModelCheck = Schema.Struct({
  model: Schema.String,
  result: LocalProbe.CheckResult,
  message: Schema.optional(Schema.String),
  context: Schema.optional(Schema.Finite),
  ttft_ms: Schema.optional(Schema.Finite),
  requests: Schema.Finite,
  checked_at: Schema.Finite,
  server_version: Schema.optional(Schema.String),
}).annotate({ identifier: "LocalModelCheck" })

export const LocalCheckResult = Schema.Struct({
  ...LocalSettings.CheckReport.fields,
  /** The model check, when the request named a model. */
  model: Schema.optional(LocalModelCheck),
}).annotate({ identifier: "LocalCheckResult" })

export const LocalGrantPayload = Schema.Struct({
  source: Schema.String,
})

const Suggestion = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  publisher: Schema.String,
  licence: Schema.String,
  quantization: Schema.String,
  memory_gb: Schema.Finite,
  context: Schema.Finite,
  tools: Schema.Boolean,
  serve: Schema.Array(Schema.String),
  ollama: Schema.optional(Schema.String),
  links: Schema.Array(Schema.String),
}).annotate({ identifier: "LocalSuggestion" })

export const LocalRecommendation = Schema.Struct({
  hardware: Schema.Struct({
    /** "This computer has 32 GB of memory shared with its GPU; about 21 GB of it can hold a model." */
    summary: Schema.String,
    kind: Schema.Literals(["unified", "gpu", "cpu"]),
    total: Schema.Finite,
    usable: Schema.Finite,
  }),
  tier: Schema.String,
  summary: Schema.String,
  note: Schema.optional(Schema.String),
  /** The label every view of these examples carries: "Examples, October 2026. Check each model's licence." */
  label: Schema.String,
  date: Schema.String,
  /** The model for each role, or null when the memory is too small for that role. */
  roles: Schema.Record(Schema.String, Schema.NullOr(Suggestion)),
  alternatives: Schema.Array(Suggestion),
}).annotate({ identifier: "LocalRecommendation" })

const errors = [LocalApiError, LocalConfirmError]

export const LocalApi = HttpApi.make("local")
  .add(
    HttpApiGroup.make("local")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
          success: described(LocalSettings.Status, "Vector Local's policy in effect"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "local.get",
            summary: "Get Vector Local",
            description:
              "The Vector Local policy in effect for this Vector: on or off, Web access, the model server list, the services you allowed and what the policy files said. Also a change to your config that would loosen it and waits for you, the keys a company lock keeps, where the network log is kept, and every kind of request Vector makes.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          query: WorkspaceRoutingQuery,
          payload: LocalSettings.Update,
          success: described(LocalSettings.Status, "Vector Local after the change"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "local.update",
            summary: "Change Vector Local",
            description:
              "Change Vector Local in your user config. A change is judged by what it changes in the settings in effect, so a change your config holds is never part of it. A change that makes it stricter applies at once. One that would loosen it (turn it off, a looser Web access, a new model server, a new or removed identity pin for a server on the list, a newly allowed service or site) fails with LocalConfirmError and the list of what it loosens, unless the request says `confirm: true`, which an owner's app sends only after asking. Turning Vector Local on applies at once, and holds the services, internet model servers and sites your config lets through until you confirm them. With `held`, it applies the change your config holds instead, and only as `held` lists it. A Vector an agent started cannot loosen it, even while Vector Local is off, and under a company lock only the keys your company left to you change.",
          }),
        ),
        HttpApiEndpoint.get("egress", `${root}/egress`, {
          query: LocalEgressQuery,
          success: described(Schema.Array(LocalMode.Event), "The network log in memory, oldest first"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "local.egress.list",
            summary: "List what Vector sent",
            description:
              "The last 2,000 requests Vector decided while Vector Local was on: when, which kind of request, where it went (origin and class), the session, the size it sent, and whether it was allowed or blocked, with the rule. Never a path, a query, a header or a body.",
          }),
        ),
        HttpApiEndpoint.get("egressSummary", `${root}/egress/summary`, {
          query: LocalSummaryQuery,
          success: described(LocalMode.Summary, "Counters for one session, or for this Vector"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "local.egress.summary",
            summary: "Summarize what Vector sent",
            description:
              "Model calls by origin, pages read and the other hosts they loaded, searches, the memory requests carried, and blocked requests by source. A session's counters include its subagents and helpers.",
          }),
        ),
        HttpApiEndpoint.get("egressExport", `${root}/egress/export`, {
          query: LocalEgressExportQuery,
          success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "application/x-ndjson" })),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "local.egress.export",
            summary: "Export what Vector sent",
            description:
              "Every event the network log keeps on this computer (30 days unless set otherwise), as JSON lines or CSV.",
          }),
        ),
        HttpApiEndpoint.delete("egressClear", `${root}/egress`, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "The network log was erased"),
          error: LocalApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "local.egress.clear",
            summary: "Erase what Vector sent",
            description:
              "Erase the network log: the events in memory, the counters and the files on this computer. Under a company lock the company sets how long the log is kept, so it fails with LocalError (locked).",
          }),
        ),
        HttpApiEndpoint.post("egressReport", `${root}/egress/report`, {
          query: WorkspaceRoutingQuery,
          payload: LocalReportPayload,
          success: described(Schema.Finite, "How many events the log took"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "local.egress.report",
            summary: "Add events to the network log",
            description:
              "Requests the desktop app's own windows made or blocked, which its main process decides, added to this Vector's network log while Vector Local is on.",
          }),
        ),
        HttpApiEndpoint.post("detect", `${root}/detect`, {
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, LocalDetectPayload],
          success: described(Schema.Array(LocalProbe.Server), "Model servers answering on this computer"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "local.detect",
            summary: "Find model servers",
            description:
              "Find the model servers running on this computer: Ollama, LM Studio, vLLM, llama.cpp and SGLang on their usual ports at 127.0.0.1 and ::1. It never scans your network; add a server elsewhere by its address.",
          }),
        ),
        HttpApiEndpoint.post("probe", `${root}/probe`, {
          query: WorkspaceRoutingQuery,
          payload: LocalProbePayload,
          success: described(LocalProbeResult, "The server at the address, or why none was read"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "local.probe",
            summary: "Read a model server",
            description:
              "Read the server at an address you typed: what kind it is, its version, its models with their context, tools and image support, and the identity Vector pins when you add it. It asks for these only; it sends no prompt. With Vector Local on, only that server is let through while it is read, and Web access None keeps internet servers blocked.",
          }),
        ),
        HttpApiEndpoint.post("addServer", `${root}/servers`, {
          query: WorkspaceRoutingQuery,
          payload: LocalAddServerPayload,
          success: described(LocalAddedServer, "The server, on the list and added as a provider"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "local.servers.add",
            summary: "Add a model server",
            description:
              "Read the server at an address, put it on the model server list with the identity it answered with, and add it to your user config as a provider with the models it runs, each with its context, reply limit, tool calling and image input. Its cloud models are left out. With Vector Local on, listing a server loosens it, so the request needs `confirm: true`, and fails with LocalConfirmError otherwise; so does adding a server on the list again when it answers as a different server, and `identity` says what changed. Headers are used to read the server and are not saved.",
          }),
        ),
        HttpApiEndpoint.post("check", `${root}/check`, {
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, LocalCheckPayload],
          success: described(LocalCheckResult, "One row per layer, and the model check when a model was named"),
          error: LocalApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "local.check",
            summary: "Check Vector Local",
            description:
              "Read every layer of Vector Local, one row each: the switch, the policy, a held change, the network guard, unlabelled requests, Vector's own services, Web access, each model server on the list (it answers, as the server it was when added) and the network log. With `model`, it also runs that model through 2 or 3 requests with the role's real tools (agent, subagent, review for Vectorscope, judge or research) and records the result in your user config; a model the model catalog lists at a cloud address keeps the catalog's limits. It reads only servers you or your company host: never a cloud AI service, and never a server on the internet that is not on your model server list. It never loads a model too big for free memory without `confirmed`.",
          }),
        ),
        HttpApiEndpoint.post("grant", `${root}/grant`, {
          query: WorkspaceRoutingQuery,
          payload: LocalGrantPayload,
          success: described(Schema.Boolean, "The grant was given"),
          error: LocalApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "local.grant",
            summary: "Allow a request once",
            description:
              "Let the next request of a kind Vector Local asks about through, such as a model download or a manual update check. Each grant answers one ask and is never saved. Allow a service for good with PATCH /local instead.",
          }),
        ),
        HttpApiEndpoint.get("recommend", `${root}/recommend`, {
          query: WorkspaceRoutingQuery,
          success: described(LocalRecommendation, "Model suggestions for this computer"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "local.recommend",
            summary: "Suggest models",
            description:
              "This computer's memory and GPUs, and the model families that fit them for each role, as dated examples from the publishers' own repositories or the Ollama library. Check each model's licence.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "local",
          description:
            "Vector Local: run Vector's AI features on model servers you or your company host, with a log of the requests Vector makes.",
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
