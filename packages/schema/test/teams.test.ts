import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Teams } from "../src/teams"

const account = { id: "11111111-1111-4111-8111-111111111111", email: "fixture@example.test" }
const org = { id: "22222222-2222-4222-8222-222222222222", name: "Fixture team", role: "member" as const }
const payload = () => ({
  version: 1 as const,
  issuer: "https://vectordev.ai" as const,
  audience: "vector-teams" as const,
  account,
  credentialHash: "a".repeat(64),
  issuedAt: 1_000,
  expiresAt: 2_000,
  orgs: [org],
  active: { id: org.id, revision: 1, config: { permission: { bash: "ask" }, model: "fixture/model" } },
})

test("Teams defines bounded serializable signed configuration without importing runtime configuration", () => {
  const decode = Schema.decodeUnknownSync(Teams.Payload, { onExcessProperty: "error" })
  expect(decode(payload())).toEqual(payload())
  expect(decode({ ...payload(), active: null })).toMatchObject({ active: null })
  expect(Teams.MAX_AGE_MS).toBe(900_000)
  expect(Teams.MAX_RESPONSE_BYTES).toBe(256_000)
  expect(Teams.MAX_CONFIG_BYTES).toBe(160_000)
  for (const change of [
    { issuer: "https://other.invalid" },
    { audience: "other" },
    { version: 2 },
    { orgs: Array(101).fill(org) },
    { account: { ...account, id: "not-a-uuid" } },
    { credentialHash: "not-a-digest" },
    { issuedAt: -1 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { active: { ...payload().active, revision: 0 } },
    { active: { ...payload().active, config: [] } },
    { orgs: [{ ...org, role: "editor" }] },
    { orgs: [{ ...org, name: "\nunsafe" }] },
    { orgs: [{ ...org, name: "x".repeat(121) }] },
    { unknown: true },
  ])
    expect(() => decode({ ...payload(), ...change })).toThrow()
})

test("Teams envelope and public keyset reject padding, alternate key forms and excess fields", () => {
  const envelope = { version: 1 as const, keyId: "fixture-key", payload: "e30", signature: "a".repeat(86) }
  const decode = Schema.decodeUnknownSync(Teams.Envelope, { onExcessProperty: "error" })
  expect(decode(envelope)).toEqual(envelope)
  for (const change of [
    { payload: "e30=" },
    { signature: "a".repeat(85) },
    { payload: "a".repeat(Teams.MAX_PAYLOAD_LENGTH + 1) },
    { keyId: "../key" },
    { extra: true },
  ])
    expect(() => decode({ ...envelope, ...change })).toThrow()
  const key = { id: "fixture", publicKey: `MCowBQYDK2VwAyEA${"a".repeat(43)}` }
  const keys = Schema.decodeUnknownSync(Teams.Keys, { onExcessProperty: "error" })
  expect(keys({ keys: [key] })).toEqual({ keys: [key] })
  for (const value of [
    { keys: [] },
    { keys: Array(4).fill(key) },
    { keys: [{ ...key, privateKey: "never" }] },
    { keys: [{ ...key, publicKey: "rsa" }] },
  ])
    expect(() => keys(value)).toThrow()
})

test("signed configuration has shared byte, depth, JSON and prototype safety limits", () => {
  expect(Teams.isConfig(payload().active.config)).toBe(true)
  for (const value of [
    null,
    [],
    { invalid: undefined },
    { invalid: NaN },
    { invalid: Infinity },
    { invalid: new Date() },
    JSON.parse('{"__proto__":{"polluted":true}}'),
    { nested: { constructor: {} } },
    { text: "🙂".repeat(40_001) },
  ])
    expect(Teams.isConfig(value)).toBe(false)
  const deep: Record<string, unknown> = {}
  const nodes = [deep]
  for (let index = 0; index < Teams.MAX_CONFIG_DEPTH + 1; index++) {
    const next = {}
    nodes.at(-1)!.next = next
    nodes.push(next)
  }
  expect(Teams.isConfig(deep)).toBe(false)
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  expect(Teams.isConfig(cycle)).toBe(false)
  expect(
    Teams.isConfig(
      Object.defineProperty({}, "getter", {
        get() {
          throw new Error("must not execute")
        },
      }),
    ),
  ).toBe(false)
})
