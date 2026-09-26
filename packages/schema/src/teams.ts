export * as Teams from "./teams"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "./schema"

export const MAX_RESPONSE_BYTES = 256_000
export const MAX_CONFIG_BYTES = 160_000
export const MAX_PAYLOAD_LENGTH = 400_000
export const MAX_AGE_MS = 15 * 60 * 1_000
export const MAX_CONFIG_DEPTH = 32

export const ID = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
).annotate({ identifier: "Teams.ID" })
export type ID = typeof ID.Type

const Label = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
)
const KeyID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))
const Milliseconds = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

export interface Organization extends Schema.Schema.Type<typeof Organization> {}
export const Organization = Schema.Struct({
  id: ID,
  name: Label,
  role: Schema.Literals(["owner", "admin", "member"]),
}).annotate({ identifier: "Teams.Organization" })

export interface Payload extends Schema.Schema.Type<typeof Payload> {}
export const Payload = Schema.Struct({
  version: Schema.Literal(1),
  issuer: Schema.Literal("https://vectordev.ai"),
  audience: Schema.Literal("vector-teams"),
  account: Schema.Struct({ id: ID, email: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(320)) }),
  credentialHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  issuedAt: Milliseconds,
  expiresAt: Milliseconds,
  orgs: Schema.Array(Organization).check(Schema.isMaxLength(100)),
  active: Schema.NullOr(
    Schema.Struct({
      id: ID,
      revision: PositiveInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
      // Decode/migrate engine configuration only after verifying the signed bytes.
      config: Schema.Record(Schema.String, Schema.Json),
    }),
  ),
}).annotate({ identifier: "Teams.Payload" })

export interface Envelope extends Schema.Schema.Type<typeof Envelope> {}
export const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  keyId: KeyID,
  payload: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/), Schema.isMaxLength(MAX_PAYLOAD_LENGTH)),
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
}).annotate({ identifier: "Teams.Envelope" })

export interface Keys extends Schema.Schema.Type<typeof Keys> {}
export const Keys = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      id: KeyID,
      // Canonical base64url of a DER Ed25519 SPKI (12-byte prefix + 32-byte key).
      publicKey: Schema.String.check(Schema.isPattern(/^MCowBQYDK2VwAyEA[A-Za-z0-9_-]{43}$/)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
}).annotate({ identifier: "Teams.Keys" })

/** Bound signed JSON before configuration migration or recursive schema decoding. */
export function isConfig(value: unknown): value is Record<string, Schema.Schema.Type<typeof Schema.Json>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  const seen = new Set<object>()
  const state = { count: 0 }
  while (pending.length) {
    const item = pending.pop()!
    if (++state.count > MAX_CONFIG_BYTES || item.depth > MAX_CONFIG_DEPTH) return false
    if (item.value === null || typeof item.value === "string" || typeof item.value === "boolean") continue
    if (typeof item.value === "number") {
      if (!Number.isFinite(item.value)) return false
      continue
    }
    if (!item.value || typeof item.value !== "object" || seen.has(item.value)) return false
    seen.add(item.value)
    const prototype = Object.getPrototypeOf(item.value)
    if (prototype !== (Array.isArray(item.value) ? Array.prototype : Object.prototype) && prototype !== null)
      return false
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item.value))) {
      if (["__proto__", "constructor", "prototype"].includes(key) || !("value" in descriptor)) return false
      if (Array.isArray(item.value) && key === "length") continue
      pending.push({ value: descriptor.value, depth: item.depth + 1 })
    }
  }
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_CONFIG_BYTES
}
