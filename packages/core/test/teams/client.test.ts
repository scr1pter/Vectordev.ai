import path from "node:path"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { expect, test } from "bun:test"
import { createTeamsClient } from "../../src/teams/client"
import { tmpdir } from "../fixture/tmpdir"

const account = "12345678-1234-4234-8234-123456789012"
const first = "12345678-1234-4234-8234-123456789013"
const second = "12345678-1234-4234-8234-123456789014"

function fixture(file: string) {
  const pair = generateKeyPairSync("ed25519")
  const state = {
    token: "vct_synthetic-teams-token",
    account,
    now: 1_800_000_000_000,
    status: 200,
    revision: 1,
    keyId: "fixture",
    corrupt: false,
    config: { model: "vector/fixture", permission: { bash: "deny" } },
    modify: (payload: Record<string, unknown>) => payload,
    afterPayload: () => {},
  }
  const requests: Array<{ pathname: string; authorization: string | null }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push({ pathname: url.pathname + url.search, authorization: request.headers.get("authorization") })
      if (state.status !== 200)
        return Response.json({ error: { code: "TEAMS_NOT_CONFIGURED" } }, { status: state.status })
      if (url.pathname === "/api/org/keys")
        return Response.json({
          keys: [
            { id: "fixture", publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url") },
          ],
        })
      const selected = url.searchParams.get("org")
      if (selected && ![first, second].includes(selected)) return new Response(null, { status: 403 })
      const payload = Buffer.from(
        JSON.stringify(
          state.modify({
            version: 1,
            issuer: "https://vectordev.ai",
            audience: "vector-teams",
            account: { id: state.account, email: "synthetic@example.invalid" },
            credentialHash: createHash("sha256").update(state.token).digest("hex"),
            issuedAt: state.now,
            expiresAt: state.now + 900_000,
            orgs: [
              { id: first, name: "Fixture team", role: "member" },
              { id: second, name: "Second team", role: "admin" },
            ],
            active: selected ? { id: selected, revision: state.revision, config: state.config } : null,
          }),
        ),
      ).toString("base64url")
      state.afterPayload()
      return Response.json({
        version: 1,
        keyId: state.keyId,
        payload,
        signature: state.corrupt
          ? Buffer.alloc(64).toString("base64url")
          : sign(null, Buffer.from(`vector-org-config-v1.${payload}`), pair.privateKey).toString("base64url"),
      })
    },
  })
  const make = () =>
    createTeamsClient({
      file,
      token: async () => state.token || undefined,
      now: () => state.now,
      request: (url, init) => {
        expect(new URL(url).origin).toBe("https://vectordev.ai")
        expect(init.redirect).toBe("error")
        return fetch(`http://127.0.0.1:${server.port}${new URL(url).pathname}${new URL(url).search}`, init)
      },
    })
  return {
    state,
    requests,
    make,
    client: make(),
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

test("personal startup is offline; explicit selection validates real signatures and stores no account token", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "teams.json")
  using sample = fixture(file)
  expect(await sample.client.current()).toEqual({ enabled: false, orgs: [] })
  expect(sample.requests).toEqual([])
  expect((await sample.client.refresh()).orgs).toHaveLength(2)
  expect((await sample.client.select(first)).active).toMatchObject({ id: first, name: "Fixture team", revision: 1 })
  expect(
    sample.requests.filter((item) => item.pathname === "/api/org/keys").every((item) => item.authorization === null),
  ).toBe(true)
  expect(
    sample.requests
      .filter((item) => item.pathname.startsWith("/api/org/config"))
      .every((item) => item.authorization === `Bearer ${sample.state.token}`),
  ).toBe(true)
  expect(await Bun.file(file).text()).not.toContain(sample.state.token)
  const count = sample.requests.length
  expect((await sample.client.current()).active?.config).toEqual(sample.state.config)
  expect(sample.requests).toHaveLength(count)
})

test.each([
  ["issuer", "https://unrelated.invalid"],
  ["audience", "another-service"],
  ["credentialHash", "0".repeat(64)],
  ["expiresAt", 1_800_000_000_000],
  ["issuedAt", 1_800_000_040_000],
  ["expiresAt", 1_800_001_000_000],
])("rejects a valid signature with an invalid %s claim", async (field, value) => {
  await using directory = await tmpdir()
  using sample = fixture(path.join(directory.path, "teams.json"))
  sample.state.modify = (payload) => ({ ...payload, [field]: value })
  await expect(sample.client.select(first)).rejects.toThrow("signed configuration")
})

test("rejects corrupt signatures, unknown keys, selected-org mismatches and polluted configuration", async () => {
  await using directory = await tmpdir()
  using sample = fixture(path.join(directory.path, "teams.json"))
  sample.state.corrupt = true
  await expect(sample.client.select(first)).rejects.toThrow("signed configuration")
  sample.state.corrupt = false
  sample.state.keyId = "unknown"
  await expect(sample.client.select(first)).rejects.toThrow("signed configuration")
  sample.state.keyId = "fixture"
  sample.state.modify = (payload) => ({ ...payload, active: null })
  await expect(sample.client.select(first)).rejects.toThrow("signed configuration")
  sample.state.modify = (payload) => ({
    ...payload,
    active: { id: first, revision: 1, config: JSON.parse('{"__proto__":{"polluted":true}}') },
  })
  await expect(sample.client.select(first)).rejects.toThrow("signed configuration")
})

test("expired policy and fresh-process key outages fail closed; explicit Personal mode still works", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "teams.json")
  using sample = fixture(file)
  await sample.client.select(first)
  sample.state.status = 503
  expect((await sample.client.current()).active?.id).toBe(first)
  await expect(sample.make().current()).rejects.toThrow("unavailable")
  sample.state.now += 900_001
  await expect(sample.client.current()).rejects.toThrow("unavailable")
  expect((await Bun.file(file).json()).selected).toBe(first)
  expect(await sample.client.select(null)).toEqual({ enabled: false, orgs: [] })
  expect(await sample.client.current()).toEqual({ enabled: false, orgs: [] })
  expect(await Bun.file(file).exists()).toBe(false)
})

test("denied membership and lower revisions preserve the last verified selection", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "teams.json")
  using sample = fixture(file)
  sample.state.revision = 5
  await sample.client.select(first)
  await expect(sample.client.select("12345678-1234-4234-8234-123456789015")).rejects.toThrow("access to that team")
  sample.state.revision = 4
  await expect(sample.client.refresh()).rejects.toThrow("signed configuration")
  expect((await Bun.file(file).json()).selected).toBe(first)
  expect((await sample.client.current()).active?.revision).toBe(5)
})

test("token rotation forces verification, different accounts cannot reuse the selection, and logout clears it", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "teams.json")
  using sample = fixture(file)
  await sample.client.select(first)
  sample.state.token = "vct_rotated-synthetic-token"
  sample.state.revision = 2
  expect((await sample.client.current()).active?.revision).toBe(2)
  sample.state.token = "vct_other-synthetic-account"
  sample.state.account = "12345678-1234-4234-8234-123456789099"
  await expect(sample.client.current()).rejects.toThrow("another Vector account")
  await sample.client.clear()
  expect(await Bun.file(file).exists()).toBe(false)
  expect((await sample.client.refresh()).account?.id).toBe(sample.state.account)
})

test("independent clients serialize changes and corrupt state can be explicitly cleared", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "teams.json")
  using sample = fixture(file)
  await Promise.all([sample.client.select(first), sample.make().select(second)])
  const selected = (await Bun.file(file).json()).selected
  expect([first, second]).toContain(selected)
  expect((await sample.make().current()).active?.id).toBe(selected)
  await Bun.write(file, "invalid stored selection")
  await expect(sample.client.current()).rejects.toThrow("team selection")
  await sample.client.select(null)
  expect(await Bun.file(file).exists()).toBe(false)
})

test("account identity is rechecked atomically before a selected team is persisted", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "teams.json")
  using sample = fixture(file)
  await sample.client.select(first, account)
  await expect(sample.client.select(second, "12345678-1234-4234-8234-123456789099")).rejects.toThrow(
    "Refresh the team list",
  )
  expect((await Bun.file(file).json()).selected).toBe(first)
  sample.state.afterPayload = () => {
    sample.state.token = "vct_rotated-mid-request"
  }
  await expect(sample.client.select(second, account)).rejects.toThrow("account changed while loading")
  expect((await Bun.file(file).json()).selected).toBe(first)
})

test("deep and oversized signed configuration fails before recursive schema decoding", async () => {
  await using directory = await tmpdir()
  using sample = fixture(path.join(directory.path, "teams.json"))
  const nested = Array.from({ length: 40 }).reduce<Record<string, unknown>>((value) => ({ child: value }), {})
  sample.state.modify = (payload) => ({ ...payload, active: { id: first, revision: 1, config: nested } })
  await expect(sample.client.select(first)).rejects.toThrow("signed configuration")
  sample.state.modify = (payload) => ({
    ...payload,
    active: { id: first, revision: 1, config: { text: "x".repeat(200_000) } },
  })
  await expect(sample.client.select(first)).rejects.toThrow("signed configuration")
})
