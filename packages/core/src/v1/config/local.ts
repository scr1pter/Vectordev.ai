export * as ConfigLocalV1 from "./local"

import { Schema } from "effect"
import { LocalMode } from "@vectordevai/schema/local-mode"
import { NonNegativeInt, PositiveInt } from "../../schema"

// The `local` block: Vector Local's settings. Only global and managed config may set it; a repository's own config
// cannot, and the keys marked "managed only" are ignored with a warning anywhere but the managed file. The pure
// resolver in `local-mode/policy.ts` turns these blocks into the policy in effect.

const Strings = Schema.mutable(Schema.Array(Schema.String))

export const Pin = Schema.Struct({
  kind: Schema.String.annotate({ description: "The kind of server Vector found, such as ollama or vllm" }),
  version: Schema.optional(Schema.String),
  models: Schema.optional(Schema.String).annotate({ description: "A hash of the model list when it was added" }),
  spki: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description: "SHA-256 of an https server's public key when it was added",
  }),
}).annotate({ identifier: "LocalPinConfig" })

export const Checked = Schema.Struct({
  server_version: Schema.optional(Schema.String),
  checked_at: NonNegativeInt,
  result: Schema.Literals(["works", "no-tools", "schema-rejected", "context-too-small", "failed"]),
  message: Schema.optional(Schema.String),
  ttft_ms: Schema.optional(NonNegativeInt),
}).annotate({ identifier: "LocalCheckedConfig" })

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Run Vector's AI features only on the model servers in endpoints (default: false)",
  }),
  web: Schema.optional(LocalMode.Web).annotate({
    description:
      "What web pages and searches may reach with Vector Local on: ask (sites you approve), network (your network and sites your company lists) or none. Default: ask.",
  }),
  endpoints: Schema.optional(Strings).annotate({
    description:
      "Origins of the model servers Vector may send prompts to, such as http://127.0.0.1:11434. Wildcard hosts (https://*.ml.corp.example.com) and address ranges (10.0.0.0/8) are read from managed config only.",
  }),
  web_domains: Schema.optional(
    Schema.Struct({
      allow: Schema.optional(Strings),
      deny: Schema.optional(Strings),
    }),
  ).annotate({ description: "Sites web pages may always reach (allow) or never reach (deny) with Vector Local on" }),
  allow: Schema.optional(Schema.mutable(Schema.Array(LocalMode.Allowed))).annotate({
    description: "Services you allowed with Vector Local on, each with the reason you gave",
  }),
  pins: Schema.optional(Schema.Record(Schema.String, Pin)).annotate({
    description: "The identity each model server had when it was added, by origin",
  }),
  checked: Schema.optional(Schema.Record(Schema.String, Checked)).annotate({
    description: "Results of Check models, by provider/model",
  }),
  ca: Schema.optional(Schema.Struct({ files: Schema.optional(Strings) })).annotate({
    description: "Certificate files added to the system and default certificates",
  }),
  log: Schema.optional(Schema.Struct({ retain_days: Schema.optional(PositiveInt) })).annotate({
    description: "How long the network log is kept on this computer (default: 30 days)",
  }),
  lock: Schema.optional(Schema.Boolean).annotate({
    description: "Managed only: the managed block is authoritative and Vector Local stays on",
  }),
  user_may: Schema.optional(
    Schema.mutable(Schema.Array(Schema.Literals(["endpoints", "allow", "web_domains", "web"]))),
  ).annotate({
    description: "Managed only: keys a user may still change under a lock (web only to a stricter setting)",
  }),
  locked_keys: Schema.optional(Strings).annotate({
    description: "Managed only: other config keys a user may not change under a lock",
  }),
  endpoint_domains: Schema.optional(Strings).annotate({
    description: "Managed only: patterns that endpoints a user adds must match under a lock",
  }),
  updates: Schema.optional(Schema.Struct({ url: Schema.String })).annotate({
    description: "Managed only: a company mirror for updates",
  }),
  models_dir: Schema.optional(Schema.String).annotate({
    description: "Managed only: a folder holding the memory-search and dictation model files",
  }),
  catalog_path: Schema.optional(Schema.String).annotate({
    description: "Managed only: a model catalog file to use instead of downloading one",
  }),
  recommend: Schema.optional(Schema.NullOr(Schema.Json)).annotate({
    description: "Managed only: replaces the bundled model recommendations",
  }),
}).annotate({ identifier: "LocalConfig" })
export type Info = Schema.Schema.Type<typeof Info>
