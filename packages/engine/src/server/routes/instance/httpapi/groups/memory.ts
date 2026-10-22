import { Schema } from "effect"
import { Multipart } from "effect/unstable/http"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { RunBudget } from "@vectordevai/schema/run-budget"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/memory"

export const MemoryListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(BrainSchema.Scope),
  // learned: what Vector put in use on its own, newest first, for Recently learned.
  filter: Schema.optional(Schema.Literals(["active", "review", "archived", "all", "learned"])),
  query: Schema.optional(Schema.String),
})

export const MemoryStats = Schema.Struct({
  active: Schema.Finite,
  review: Schema.Finite,
  archived: Schema.Finite,
  rules: Schema.Finite,
  learned: Schema.Finite,
  digestTokens: Schema.Finite,
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
  action: Schema.optional(Schema.Literals(["approve", "reject", "archive", "restore", "undo"])),
})

export const MemoryErasePayload = Schema.Struct({
  scope: Schema.Literals(["repository", "personal", "all"]),
})

export const MemorySettings = Schema.Struct({
  learning: Schema.Boolean,
  /** Whether the repository's tracked docs are read. */
  repositoryDocs: Schema.Boolean,
  /** Whether a copy of each added file is kept. The copy is not redacted. */
  keepOriginals: Schema.Boolean,
}).annotate({ identifier: "MemorySettings" })

export const MemorySettingsPayload = Schema.Struct({
  learning: Schema.optional(Schema.Boolean),
  repositoryDocs: Schema.optional(Schema.Boolean),
  keepOriginals: Schema.optional(Schema.Boolean),
})

export const MemoryTidy = Schema.Struct({
  merged: Schema.Finite,
  promoted: Schema.Finite,
  archived: Schema.Finite,
  dropped: Schema.Finite,
  stale: Schema.Finite,
}).annotate({ identifier: "MemoryTidy" })

export class MemoryApiError extends Schema.ErrorClass<MemoryApiError>("MemoryError")(
  {
    name: Schema.Literal("MemoryError"),
    data: Schema.Struct({
      code: Schema.Literals(["refused", "not-found"]),
      message: Schema.String,
      /** Why a document was refused, such as "unsupported", "secret" or "version". */
      reason: Schema.optional(Schema.String),
      /** For "version": the document the file would replace, so the user can be asked. */
      document: Schema.optional(BrainSchema.Document),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class MemoryTooLargeError extends Schema.ErrorClass<MemoryTooLargeError>("MemoryTooLargeError")(
  {
    name: Schema.Literal("MemoryTooLargeError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 413 },
) {}

const MemoryID = Schema.String.annotate({ description: "A memory entry's short id, such as m4k2q" })
const DocumentID = Schema.String.annotate({ description: "A document's id, such as d4k2q7m3x" })
const RecordID = Schema.String.annotate({ description: "A record's id, such as r4k2q7m3x9ab" })

/** The most an upload may hold: the most Vector reads of any document. */
export const UPLOAD_BYTES = 64 * 1024 * 1024
/** The most pasted text a document may be. */
export const TEXT_BYTES = 2 * 1024 * 1024

export const MemoryDocumentLimits = Schema.Struct({
  /** Bytes of one upload. */
  upload: Schema.Finite,
  /** Bytes of pasted text. */
  text: Schema.Finite,
  /** Uploaded and chat documents per repository, and the repository's own docs beside them. */
  documents: Schema.Finite,
  repository: Schema.Finite,
  /** Documents added per minute. */
  perMinute: Schema.Finite,
}).annotate({ identifier: "MemoryDocumentLimits" })

export const MemoryWorker = Schema.Struct({
  /** in-process: documents are read on the main thread under tighter limits, for `reason`. */
  mode: Schema.Literals(["worker", "in-process"]),
  reason: Schema.optional(Schema.String),
  threads: Schema.Finite,
}).annotate({ identifier: "MemoryWorker" })

/** A change to the local search model: download, remove, install from a folder, or pause and resume embedding. */
export const MemoryModelPayload = Schema.Struct({
  action: Schema.Literals(["download", "remove", "install", "pause", "resume"]),
  /** Which model; the default (arctic-embed-xs int8) when absent. */
  model: Schema.optional(Schema.Literals(["arctic-embed-xs-q8", "granite-small-r2-q8"])),
  /** fp32: the full-precision graph, offered when the int8 one fails its check on this computer. */
  variant: Schema.optional(BrainSchema.ModelVariant),
  /** For install: a folder on this computer holding the model's files. */
  from: Schema.optional(Schema.String),
}).annotate({ identifier: "MemoryModelPayload" })

export const MemoryDocumentList = Schema.Struct({
  documents: Schema.Array(BrainSchema.Document),
  model: BrainSchema.ModelStatus,
  settings: MemorySettings,
  limits: MemoryDocumentLimits,
  /** Something is being read or waits to be: poll again in a couple of seconds. */
  indexing: Schema.Boolean,
  worker: MemoryWorker,
}).annotate({ identifier: "MemoryDocumentList" })

export const MemoryDocumentResult = Schema.Struct({
  /** queued: new; version: the next version of a document here, which it replaces; unchanged: these bytes are here. */
  type: Schema.Literals(["queued", "unchanged", "version"]),
  document: BrainSchema.Document,
  previous: Schema.optional(Schema.String),
}).annotate({ identifier: "MemoryDocumentResult" })

const DocumentOriginField = Schema.optional(Schema.Literals(["upload", "chat"]))

export const MemoryDocumentUploadPayload = Schema.Struct({
  file: Multipart.SingleFileSchema,
  origin: DocumentOriginField,
  sessionID: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  /** "true" reads a file of the same name as a document here as its next version; otherwise that is refused first. */
  replace: Schema.optional(Schema.Literals(["true", "false"])),
}).pipe(
  HttpApiSchema.asMultipartStream({
    maxParts: 5,
    maxFileSize: UPLOAD_BYTES,
    maxTotalSize: UPLOAD_BYTES + 1024 * 1024,
    maxFieldSize: 16 * 1024,
  }),
)

export const MemoryDocumentPathPayload = Schema.Struct({
  /** A file the user chose, as an absolute path, or a file of the repository, relative to it. Never a link. */
  path: Schema.String,
  origin: DocumentOriginField,
  sessionID: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  replace: Schema.optional(Schema.Boolean),
})

export const MemoryDocumentTextPayload = Schema.Struct({
  name: Schema.String,
  text: Schema.String,
  sessionID: Schema.optional(Schema.String),
  replace: Schema.optional(Schema.Boolean),
})

export const MemoryDocumentProbePayload = Schema.Struct({ path: Schema.String })

export const MemoryDocumentProbe = Schema.Struct({
  format: BrainSchema.Format,
  pages: Schema.optional(Schema.Finite),
  /** About what sending the document whole would cost. */
  tokens: Schema.Finite,
  /** remember-instead: a PDF over 20 pages or a file over 1 MB, which costs less remembered than sent. */
  suggest: Schema.Literals(["remember-instead", "none"]),
}).annotate({ identifier: "MemoryDocumentProbe" })

export const MemoryRecordPage = Schema.Struct({
  records: Schema.Array(BrainSchema.Record),
  /** Pass as `cursor` for the next page; absent on the last. */
  cursor: Schema.optional(Schema.String),
}).annotate({ identifier: "MemoryRecordPage" })

export const MemoryDocumentDetail = Schema.Struct({
  document: BrainSchema.Document,
  /** Sections, at most 200. */
  outline: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      heading: Schema.String,
      path: Schema.String,
      level: Schema.Finite,
      pageStart: Schema.optional(Schema.Finite),
      pageEnd: Schema.optional(Schema.Finite),
    }),
  ),
  counts: Schema.Struct({
    records: Schema.Finite,
    active: Schema.Finite,
    held: Schema.Finite,
    archived: Schema.Finite,
    passages: Schema.Finite,
  }),
  /** The first 50 records in document order; GET /memory/records with `document` and `cursor` gives the rest. */
  records: MemoryRecordPage,
  /** At most 100. */
  anchors: Schema.Array(BrainSchema.Anchor),
  /** Passages and records held for the user's review, at most 50. */
  held: Schema.Array(Schema.Struct({ id: Schema.String, hold: BrainSchema.Hold, page: Schema.optional(Schema.Finite) })),
  warnings: Schema.Array(BrainSchema.DocumentWarning),
  versions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      version: Schema.Finite,
      status: BrainSchema.DocumentStatus,
      bytes: Schema.Finite,
      createdAt: Schema.Finite,
    }),
  ),
  /** What this version changed from the one before; absent for a first version. */
  diff: Schema.optional(BrainSchema.VersionDiff),
  /** The document's steps, newest first, at most 50: added, a new version, records changed, linked, edited, decided. */
  history: Schema.Array(BrainSchema.DocumentEvent),
  /** Runs in the last 30 days whose answers cited or opened one of its cards, and how they ended. */
  usage: BrainSchema.DocumentUsage,
  /** Whether "Find more with a model…" is on (VECTOR_KNOWLEDGE_DISTILL); absent from an engine without it. */
  distill: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MemoryDocumentDetail" })

export const MemoryDocumentUpdatePayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  visibility: Schema.optional(BrainSchema.Visibility),
  /**
   * reject forgets a held document; reindex reads it again; pause and resume hold and continue its reading;
   * keep-suggestions puts every record a model suggested for it in use.
   */
  action: Schema.optional(Schema.Literals(["approve", "reject", "reindex", "pause", "resume", "keep-suggestions"])),
})

const DistillTokens = Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 1_000, maximum: 30_000 }))

export const MemoryDistillQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  /** "provider/model"; the configured default model when absent. */
  model: Schema.optional(Schema.String),
  /** Section text to send, in tokens: 1,000 to 30,000, the default. */
  maxTokens: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1_000, maximum: 30_000 })),
  ),
})

const DistillReason = Schema.Literals([
  "off",
  "guest",
  "may-train",
  "zen",
  "no-model",
  "not-found",
  "held",
  "not-ready",
  "nothing",
])

export const MemoryDistillEstimate = Schema.Struct({
  /** VECTOR_KNOWLEDGE_DISTILL is set. */
  enabled: Schema.Boolean,
  /** "provider/model". */
  model: Schema.optional(Schema.String),
  /** Why it would not run: off, a guest's session, a model that may train, the Zen gateway, nothing to read. */
  refused: Schema.optional(Schema.Struct({ reason: DistillReason, message: Schema.String })),
  /** Sections that would be sent, the tokens sent, and the output cap. */
  sections: Schema.Finite,
  input: Schema.Finite,
  output: Schema.Finite,
  costKind: Schema.optional(RunBudget.CostKind),
  /** At catalog rates, for a priced model. */
  lowUsd: Schema.optional(Schema.Finite),
  highUsd: Schema.optional(Schema.Finite),
}).annotate({ identifier: "MemoryDistillEstimate" })

export const MemoryDistillPayload = Schema.Struct({
  model: Schema.optional(Schema.String),
  maxTokens: Schema.optional(DistillTokens),
  /** The session it was asked from: a guest in it refuses the request, and the helper's spend counts there. */
  sessionID: Schema.optional(Schema.String),
})

export const MemoryDistillResult = Schema.Struct({
  model: Schema.String,
  /** The hidden helper session the request ran in; it is never listed. */
  sessionID: Schema.String,
  /** The suggestions that held their quotes, as proposed records for the user to keep or drop. */
  records: Schema.Array(BrainSchema.Record),
  /** Suggestions that said what a record of the document already says. */
  duplicate: Schema.Finite,
  /** Suggestions dropped: not readable, a quote not in the document, or text a scan failed. */
  dropped: Schema.Struct({ invalid: Schema.Finite, quote: Schema.Finite, scan: Schema.Finite }),
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cacheRead: Schema.Finite,
    cacheWrite: Schema.Finite,
  }),
  cost: Schema.Finite,
  costKind: RunBudget.CostKind,
  /** Why the model gave nothing usable, when it did not. */
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "MemoryDistillResult" })

export const MemoryDocumentPage = Schema.Struct({
  document: Schema.String,
  page: Schema.Finite,
  pages: Schema.Finite,
  /** The page is a scanned image with no text, so Vector read nothing on it. */
  unread: Schema.Boolean,
  passages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      section: Schema.String,
      /** The page the passage starts on; one that starts before this page runs onto it. */
      page: Schema.optional(Schema.Finite),
      /** Plain text; never render it as markup. */
      text: Schema.String,
      hold: Schema.optional(BrainSchema.Hold),
      /** Where each record's quote sits in `text`. */
      records: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          kind: BrainSchema.RecordKind,
          start: Schema.Finite,
          end: Schema.Finite,
          page: Schema.optional(Schema.Finite),
        }),
      ),
    }),
  ),
}).annotate({ identifier: "MemoryDocumentPage" })

export const MemoryRecordQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  kind: Schema.optional(BrainSchema.RecordKind),
  document: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["active", "held", "archived", "all"])),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))),
})

export const MemoryRecordDetail = Schema.Struct({
  record: BrainSchema.Record,
  passage: Schema.optional(BrainSchema.Passage),
  anchors: Schema.Array(BrainSchema.Anchor),
  conflicts: Schema.Array(BrainSchema.ReviewItem),
  history: Schema.Array(BrainSchema.RecordEvent),
}).annotate({ identifier: "MemoryRecordDetail" })

export const MemoryRecordUpdatePayload = Schema.Struct({
  text: Schema.optional(Schema.String),
  kind: Schema.optional(BrainSchema.RecordKind),
  pinned: Schema.optional(Schema.Boolean),
  action: Schema.optional(Schema.Literals(["not-applicable", "forget", "restore", "make-memory"])),
  /** Link the record to a file of the repository, at a symbol's definition when one is given. */
  link: Schema.optional(Schema.Struct({ path: Schema.String, symbol: Schema.optional(Schema.String) })),
  /** Take a link away by its number; Vector does not make it again. */
  unlink: Schema.optional(Schema.Finite),
})

export const MemoryRecordResult = Schema.Struct({
  record: BrainSchema.Record,
  /** The memory entry `make-memory` saved. */
  entry: Schema.optional(BrainSchema.Entry),
}).annotate({ identifier: "MemoryRecordResult" })

export const MemoryLinksQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  /** A file of the repository, relative to it. */
  file: Schema.String,
})

export const MemoryReviewQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  /** "true" checks links against the code first, so drift is current. */
  check: Schema.optional(Schema.Literals(["true", "false"])),
})

export const MemoryReviewPayload = Schema.Struct({
  /**
   * dismiss: not an issue. keep-document / keep-code: for drift, which side is right. keep: for a conflict, keep the
   * side `winner` names and put the other away. approve / reject: for held content.
   */
  action: Schema.Literals(["dismiss", "keep-document", "keep-code", "keep", "approve", "reject"]),
  winner: Schema.optional(Schema.String),
})

export const MemoryReviewResult = Schema.Struct({
  /** The item as it is now; held content that was settled has none. */
  item: Schema.optional(BrainSchema.ReviewItem),
  /** The decision `keep-code` saved. */
  entry: Schema.optional(BrainSchema.Entry),
}).annotate({ identifier: "MemoryReviewResult" })

const ReviewItemID = Schema.String.annotate({
  description: "A review item's id: v… for a conflict or drift, or the held passage, record or document's own id",
})

/** Characters one post may send for a check, every part together. */
export const POSTING_CHARS = 2_000_000

export const MemoryPostingPayload = Schema.Struct({
  /** Everything one post sends, in order: a title and body, or a review's body, each line comment and its fallback. */
  parts: Schema.Array(Schema.String),
  /** Sessions whose recalled memory the text is compared with too, with the sessions they launched. */
  sessionIDs: Schema.optional(Schema.Array(Schema.String)),
  /** The user typed or edited the text: it is never changed, only asked about. */
  typed: Schema.Boolean,
  /** A pull request from someone Vector cannot trust: its links and images may point only at GitHub and `hosts`. */
  untrusted: Schema.optional(Schema.Boolean),
  /** The repository's own hosts, besides GitHub's. */
  hosts: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "MemoryPostingPayload" })

export const MemoryPostingResult = Schema.Struct({
  /** clean: nothing overlaps. changed: what overlaps was taken out. ask: the user's own text overlaps, unchanged. */
  status: Schema.Literals(["clean", "changed", "ask"]),
  /** The parts to post, in the order they were sent. */
  parts: Schema.Array(Schema.String),
  /** The sentences that overlap the owner's memory, by part, to show the owner before posting. */
  dropped: Schema.Array(Schema.Struct({ part: Schema.Finite, text: Schema.String })),
  /** Links and images taken out because they point off GitHub. */
  links: Schema.Finite,
}).annotate({ identifier: "MemoryPostingResult" })

export const MemoryKnowledgeQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  /** Record, passage and document ids, comma-separated, at most 50. */
  ids: Schema.String,
})

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
              "Rules, saved preferences and what Vector learned for the repository at `directory` and for the user, with counts. `filter=learned` lists what Vector put in use on its own, newest first.",
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
            description:
              "Edit, pin or unpin, approve or reject a held entry, archive or restore. `undo` takes back what Vector learned: it is archived as your decision and Vector does not learn it again.",
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
          success: described(Schema.Finite, "How many entries were erased"),
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
            description: "Merge duplicates, drop what waited for review too long, archive what goes unused and mark stale entries.",
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
          payload: MemorySettingsPayload,
          success: described(MemorySettings, "Memory settings after the change"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.settings.update",
            summary: "Change memory settings",
            description:
              "Turn Vector's learning on or off, reading the repository's own docs, and keeping originals of added documents. Memory already saved stays until you erase it; turning repository docs off forgets what Vector read of them, and turning originals off deletes the kept copies.",
          }),
        ),
        HttpApiEndpoint.get("model", `${root}/model`, {
          query: WorkspaceRoutingQuery,
          success: described(BrainSchema.ModelStatus, "The local search model, and how much of the repository's documents it has embedded"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.model.get",
            summary: "Get the search model",
            description:
              "Whether the local model Vector searches documents by meaning with is downloaded, downloading, ready or failed its check on this computer, with every model it can download (size, license, source and sha256) and how much of the repository's documents it has embedded. Until it is ready, search uses keywords and code links.",
          }),
        ),
        HttpApiEndpoint.post("changeModel", `${root}/model`, {
          query: WorkspaceRoutingQuery,
          payload: MemoryModelPayload,
          success: described(BrainSchema.ModelStatus, "The search model after the change"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.model.update",
            summary: "Change the search model",
            description:
              "download starts the one-time download in the background (poll GET /memory/model); install copies the pinned files from a folder on this computer, for one with no network; remove deletes every downloaded model and the vectors made with it; pause and resume hold or continue embedding in the background. Each file is used only at its pinned size and sha256, except the Code-aware preview's tokenizer.json and tokenizer_config.json, which are checked by size and taken only from Hugging Face at the preview's pinned revision.",
          }),
        ),
        HttpApiEndpoint.get("documents", `${root}/documents`, {
          query: WorkspaceRoutingQuery,
          success: described(MemoryDocumentList, "The repository's documents, with settings, limits and progress"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.documents.list",
            summary: "List documents",
            description:
              "Documents Vector keeps for the repository at `directory`: uploads, attachments, what the agent kept and the repository's own docs. Poll every couple of seconds while `indexing` is true.",
          }),
        ),
        HttpApiEndpoint.post("upload", `${root}/documents`, {
          query: WorkspaceRoutingQuery,
          payload: MemoryDocumentUploadPayload,
          success: described(MemoryDocumentResult, "The document, queued to be read"),
          error: [MemoryApiError, MemoryTooLargeError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.documents.upload",
            summary: "Upload a document",
            description:
              "Upload one file (at most 64 MB) as multipart form data. It is read on this computer into sections, passages and records. A file of the same name as a document here is refused with reason `version` unless `replace` is `true`.",
          }),
        ),
        HttpApiEndpoint.post("addPath", `${root}/documents/path`, {
          query: WorkspaceRoutingQuery,
          payload: MemoryDocumentPathPayload,
          success: described(MemoryDocumentResult, "The document, queued to be read"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.documents.path",
            summary: "Add a document by path",
            description:
              "Add a file on the computer the engine runs on: an absolute path the user chose, or a path inside the repository. Only regular files are read, never a link, and a repository path must not lead out of it.",
          }),
        ),
        HttpApiEndpoint.post("addText", `${root}/documents/text`, {
          query: WorkspaceRoutingQuery,
          payload: MemoryDocumentTextPayload,
          success: described(MemoryDocumentResult, "The document, queued to be read"),
          error: [MemoryApiError, MemoryTooLargeError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.documents.text",
            summary: "Add pasted text as a document",
            description: "Keep pasted text (at most 2 MB) as a Markdown document named `name`.",
          }),
        ),
        HttpApiEndpoint.post("probe", `${root}/documents/probe`, {
          query: WorkspaceRoutingQuery,
          payload: MemoryDocumentProbePayload,
          success: described(MemoryDocumentProbe, "The file's format, pages and size in tokens"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.documents.probe",
            summary: "Probe a document",
            description:
              "Read a file by path only for its format, pages and size in tokens, storing nothing, so the composer can suggest remembering it instead of sending it.",
          }),
        ),
        HttpApiEndpoint.get("document", `${root}/documents/:documentID`, {
          params: { documentID: DocumentID },
          query: WorkspaceRoutingQuery,
          success: described(MemoryDocumentDetail, "One document with its outline, first records and versions"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.documents.get",
            summary: "Get a document",
            description: "One document: its outline, counts, first records, code links, held passages, warnings and versions.",
          }),
        ),
        HttpApiEndpoint.patch("updateDocument", `${root}/documents/:documentID`, {
          params: { documentID: DocumentID },
          query: WorkspaceRoutingQuery,
          payload: MemoryDocumentUpdatePayload,
          success: described(BrainSchema.Document, "The document after the change"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.documents.update",
            summary: "Change a document",
            description:
              "Rename it, change who may see it, approve or reject a held document, read it again, or pause and resume its reading.",
          }),
        ),
        HttpApiEndpoint.delete("removeDocument", `${root}/documents/:documentID`, {
          params: { documentID: DocumentID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "The document was forgotten"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.documents.remove",
            summary: "Forget a document",
            description:
              "Forget a document and every version of it: its records, passages, links and kept copy. Vector does not keep it again on its own; you can always add it again.",
          }),
        ),
        HttpApiEndpoint.get("documentPage", `${root}/documents/:documentID/pages/:page`, {
          params: { documentID: DocumentID, page: Schema.String.annotate({ description: "A page number, from 1" }) },
          query: WorkspaceRoutingQuery,
          success: described(MemoryDocumentPage, "The page's text with the spans its records came from"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.documents.page",
            summary: "Read a page of a document",
            description: "The text Vector read from one page of a paged document, with where each record's quote sits.",
          }),
        ),
        HttpApiEndpoint.get("documentFile", `${root}/documents/:documentID/file`, {
          params: { documentID: DocumentID },
          query: WorkspaceRoutingQuery,
          success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" })),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.documents.file",
            summary: "Download a document's original",
            description:
              "The original file as it was added, as an attachment, only while the repository keeps originals. The copy is not redacted.",
          }),
        ),
        HttpApiEndpoint.get("distillEstimate", `${root}/documents/:documentID/distill`, {
          params: { documentID: DocumentID },
          query: MemoryDistillQuery,
          success: described(MemoryDistillEstimate, "What finding more with a model would send and may cost"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.distill.estimate",
            summary: "Estimate finding more with a model",
            description:
              "The sections a model would read for suggestions, the tokens sent, the output cap and, for a priced model, the cost at catalog rates; or why it would be refused. Nothing is sent.",
          }),
        ),
        HttpApiEndpoint.post("distill", `${root}/documents/:documentID/distill`, {
          params: { documentID: DocumentID },
          query: WorkspaceRoutingQuery,
          payload: MemoryDistillPayload,
          success: described(MemoryDistillResult, "The suggestions kept for review, and what the request spent"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.distill.run",
            summary: "Find more with a model",
            description:
              "Off unless VECTOR_KNOWLEDGE_DISTILL is set. A model reads the document's sections where Vector's rules found little, in a hidden helper session, and each suggestion is kept only if its quote is the document's own words. Kept suggestions wait as proposed records. Refused for a session a guest is in, a model that may train on prompts and the Zen gateway.",
          }),
        ),
        HttpApiEndpoint.get("records", `${root}/records`, {
          query: MemoryRecordQuery,
          success: described(MemoryRecordPage, "A page of records"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.records.list",
            summary: "List records",
            description:
              "Records Vector read from documents, in document order, or best first for `query`. Filter by `kind`, `document` and `status` (archived records are left out unless asked for); pass `cursor` for the next page.",
          }),
        ),
        HttpApiEndpoint.get("record", `${root}/records/:recordID`, {
          params: { recordID: RecordID },
          query: WorkspaceRoutingQuery,
          success: described(MemoryRecordDetail, "One record with its passage, links, conflicts and history"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.records.get",
            summary: "Get a record",
            description: "One record: the passage it came from, the code it is linked to, what it conflicts with and how it changed.",
          }),
        ),
        HttpApiEndpoint.patch("updateRecord", `${root}/records/:recordID`, {
          params: { recordID: RecordID },
          query: WorkspaceRoutingQuery,
          payload: MemoryRecordUpdatePayload,
          success: described(MemoryRecordResult, "The record after the change"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.records.update",
            summary: "Change a record",
            description:
              "Edit a record's text or kind, pin it, say it is not what Vector called it, forget or restore it, or save it as a memory entry. Edits and decisions hold when the document is read again.",
          }),
        ),
        HttpApiEndpoint.get("links", `${root}/links`, {
          query: MemoryLinksQuery,
          success: described(Schema.Array(BrainSchema.Link), "What is linked to the file"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.links",
            summary: "List a file's links",
            description:
              "Document records and passages linked to a file of the repository (by a definition, a use, a route, an env read, a constant or a path), with each link's state, and memory entries whose paths cover the file.",
          }),
        ),
        HttpApiEndpoint.get("review", `${root}/review`, {
          query: MemoryReviewQuery,
          success: described(Schema.Array(BrainSchema.ReviewItem), "What needs the user's look"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.review.list",
            summary: "List what needs a look",
            description:
              "Open items for the user: documents, rules and memory that disagree, linked code that drifted from what a document says (with values, such as 50 MB against 64 MB), and held documents, passages and records.",
          }),
        ),
        HttpApiEndpoint.patch("resolveReview", `${root}/review/:itemID`, {
          params: { itemID: ReviewItemID },
          query: WorkspaceRoutingQuery,
          payload: MemoryReviewPayload,
          success: described(MemoryReviewResult, "The item after the decision"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.review.resolve",
            summary: "Settle an item",
            description:
              "The user's decision on an item: dismiss it, keep the document or the code for drift (keeping the code saves a decision), keep one side of a conflict, or approve or reject held content. Vector never settles one itself.",
          }),
        ),
        HttpApiEndpoint.post("postingCheck", `${root}/posting-check`, {
          query: WorkspaceRoutingQuery,
          payload: MemoryPostingPayload,
          success: described(MemoryPostingResult, "What may be posted, and what overlaps the owner's memory"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.posting.check",
            summary: "Check text before Vector posts it",
            description:
              "Compares text Vector is about to post or commit with the owner's memory: how they work, what they told Vector about themselves, and private documents the given sessions recalled. A sentence that repeats one is taken out of text Vector wrote, and only shown for text the user typed. A fork's links and images may point only at GitHub.",
          }),
        ),
        HttpApiEndpoint.get("knowledge", `${root}/knowledge`, {
          query: MemoryKnowledgeQuery,
          success: described(Schema.Array(BrainSchema.Card), "Cards for the ids that are still there"),
          error: MemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.knowledge",
            summary: "Resolve citations",
            description:
              "The cards for record, passage and document ids an answer cited, for citation chips. Ids that are gone or held are left out.",
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
