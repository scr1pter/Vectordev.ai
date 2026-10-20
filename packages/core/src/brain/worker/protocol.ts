export * as BrainWorkerProtocol from "./protocol"

import { Schema } from "effect"
import { BrainSchema } from "../schema"

// What the brain's background reader and the process it serves say to each other. The reader parses files from
// anywhere, so what it sends back is decoded like any untrusted input before the knowledge store writes a row of it.

/** Which set of reading limits applies: the worker's, or the tighter one for reading on the main thread. */
export const LimitsName = Schema.Literals(["worker", "inline"])
export type LimitsName = typeof LimitsName.Type

export const Ping = Schema.Struct({ id: Schema.Finite, type: Schema.Literal("ping") })

/** Read, structure and extract a document. `document` is the id of the version being read, which section ids name. */
export const Extract = Schema.Struct({
  id: Schema.Finite,
  type: Schema.Literal("extract"),
  name: Schema.String,
  bytes: Schema.Uint8Array,
  mime: Schema.optional(Schema.String),
  repository: Schema.String,
  lineage: Schema.String,
  document: Schema.String,
  limits: LimitsName,
})

/** Only read a document, for its format, pages and size in tokens. */
export const Probe = Schema.Struct({
  id: Schema.Finite,
  type: Schema.Literal("probe"),
  name: Schema.String,
  bytes: Schema.Uint8Array,
  mime: Schema.optional(Schema.String),
  limits: LimitsName,
})

/** How a model turns text into a vector, from its manifest. */
export const EmbedSettings = Schema.Struct({
  dims: Schema.Finite,
  pooling: Schema.Literals(["cls", "mean"]),
  maxTokens: Schema.Finite,
  queryTokens: Schema.Finite,
  query: Schema.String,
})
export type EmbedSettings = typeof EmbedSettings.Type

export const Role = Schema.Literals(["query", "passage"])

/**
 * Load the local search model from its files' bytes and ONNX Runtime's wasm, then embed the canary sentences for the
 * host to compare with their pinned vectors. `key` names the model, revision and graph.
 */
export const Load = Schema.Struct({
  id: Schema.Finite,
  type: Schema.Literal("load"),
  key: Schema.String,
  wasm: Schema.Uint8Array,
  model: Schema.Uint8Array,
  /** The graph's weights when they are a file of their own, under the name the graph gives that file. */
  data: Schema.optional(Schema.Uint8Array),
  dataName: Schema.optional(Schema.String),
  tokenizer: Schema.String,
  config: Schema.String,
  settings: EmbedSettings,
  canaries: Schema.Array(Schema.Struct({ text: Schema.String, role: Role, vector: Schema.Array(Schema.Finite) })),
})
export type Load = typeof Load.Type

/** Embed texts with the loaded model. */
export const Embed = Schema.Struct({
  id: Schema.Finite,
  type: Schema.Literal("embed"),
  key: Schema.String,
  texts: Schema.Array(Schema.String),
  role: Role,
})
export type Embed = typeof Embed.Type

export const Request = Schema.Union([Ping, Extract, Probe, Load, Embed])
export type Request = typeof Request.Type

const Hold = Schema.Literals(["hidden-text", "hidden-unicode", "instruction-like"])

export const Section = Schema.Struct({
  id: Schema.String,
  ordinal: Schema.Finite,
  parent: Schema.optional(Schema.Finite),
  level: Schema.Finite,
  heading: Schema.String,
  path: Schema.String,
  kind: Schema.Literals(["section", "slide", "sheet"]),
  pageStart: Schema.optional(Schema.Finite),
  pageEnd: Schema.optional(Schema.Finite),
  tokens: Schema.Finite,
  start: Schema.Finite,
  end: Schema.Finite,
})

export const Passage = Schema.Struct({
  id: Schema.String,
  section: Schema.Finite,
  ordinal: Schema.Finite,
  page: Schema.optional(Schema.Finite),
  header: Schema.String,
  body: Schema.String,
  tokens: Schema.Finite,
  start: Schema.Finite,
  end: Schema.Finite,
  normHash: Schema.String,
  hold: Schema.optional(Hold),
})

export const Record = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  kind: BrainSchema.RecordKind,
  subject: Schema.String,
  card: Schema.String,
  quote: Schema.String,
  quoteHash: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Unknown),
  confidence: Schema.Finite,
  rule: Schema.String,
  polarity: Schema.String,
  passage: Schema.String,
  section: Schema.Finite,
  page: Schema.optional(Schema.Finite),
  start: Schema.Finite,
  end: Schema.Finite,
  hold: Schema.optional(Hold),
})

/** A document as the store takes it: its sections, passages and records, with everything the user should be told. */
export const Structured = Schema.Struct({
  title: Schema.String,
  format: BrainSchema.Format,
  pages: Schema.optional(Schema.Finite),
  unread: Schema.Array(Schema.Finite),
  warnings: Schema.Array(BrainSchema.DocumentWarning),
  /** Estimated tokens of the extracted text: what sending the document whole would cost. */
  tokens: Schema.Finite,
  /** Set when so many passages are held that the whole document waits for the user. */
  hold: Schema.optional(Hold),
  held: Schema.Finite,
  sections: Schema.Array(Section),
  passages: Schema.Array(Passage),
  records: Schema.Array(Record),
  /** What the document set as code (backticks, a monospace font, a Code style), which links to code may name. */
  code: Schema.optional(Schema.Array(Schema.String)),
})
export type Structured = typeof Structured.Type

export const Probed = Schema.Struct({
  format: BrainSchema.Format,
  pages: Schema.optional(Schema.Finite),
  tokens: Schema.Finite,
})
export type Probed = typeof Probed.Type

/** The reasons a document is refused, as the readers give them. */
export const Refusal = Schema.Literals(["too-large", "unsupported", "encrypted", "empty", "secret", "invalid"])
export type Refusal = typeof Refusal.Type

export const Response = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ id: Schema.Finite, type: Schema.Literal("pong") }),
  Schema.Struct({ id: Schema.Finite, type: Schema.Literal("extracted"), result: Structured }),
  Schema.Struct({ id: Schema.Finite, type: Schema.Literal("probed"), result: Probed }),
  Schema.Struct({ id: Schema.Finite, type: Schema.Literal("refused"), reason: Refusal, message: Schema.String }),
  /** The canaries' cosines against their pinned vectors, in order, and how long loading took. */
  Schema.Struct({
    id: Schema.Finite,
    type: Schema.Literal("loaded"),
    cosines: Schema.Array(Schema.Finite),
    ms: Schema.Finite,
    dims: Schema.Finite,
  }),
  /** One vector of `dims` floats per text, one after another. */
  Schema.Struct({
    id: Schema.Finite,
    type: Schema.Literal("embedded"),
    vectors: Schema.instanceOf(Float32Array),
    dims: Schema.Finite,
  }),
  Schema.Struct({ id: Schema.Finite, type: Schema.Literal("failed"), message: Schema.String }),
])
export type Response = typeof Response.Type
