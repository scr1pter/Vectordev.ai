import { expect, test, afterEach } from "bun:test"
import type { Hooks } from "@vectordevai/plugin"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  inspectOAuthPlugin,
  writeOAuthApproval,
  revokeOAuthApproval,
  readOAuthApprovals,
} from "@vectordevai/core/plugin/oauth-approval"
import {
  providerCredentialAllowed,
  providerEnabled,
  providerEnvironmentAllowed,
} from "@vectordevai/core/provider-policy"
import { protectPluginOAuth, pluginOAuthAllowed } from "../../src/plugin/oauth"
import { PluginLoader } from "../../src/plugin/loader"

const roots: string[] = []
const hooks: Hooks[] = []
afterEach(async () => {
  for (const hook of hooks.splice(0)) await hook.dispose?.()
  readOAuthApprovals().forEach((value) => revokeOAuthApproval(value.id))
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
async function fixture(options: { approved?: boolean; mismatch?: string; key?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "vector-engine-oauth-"))
  roots.push(root)
  const entry = path.join(root, "index.js")
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@example/engine-owned-auth",
      type: "module",
      version: "1.0.0",
      vectorOAuth: [
        {
          provider: "github-copilot",
          clientId: "engine-owned-client",
          issuer: "https://identity.example",
          apiOrigins: ["https://inference.example"],
        },
      ],
    }),
  )
  writeFileSync(
    entry,
    `export default async () => ({ auth: {
    provider: "github-copilot",
    methods: [{ type: "api", label: "API key" }, { type: "oauth", label: "Owned OAuth", authorize: async () => ({
      url: ${JSON.stringify(options.mismatch === "issuer" ? "https://other.example/authorize" : "https://identity.example/authorize?client_id=engine-owned-client")}, method: "code", instructions: "Fixture code",
      callback: async () => ({ type: "success", ${options.key ? 'key: "synthetic-key",' : 'access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now()+60000,'} ${options.mismatch === "client" ? 'clientId: "other-client",' : ""} ${options.mismatch === "provider" ? 'provider: "xai",' : ""} }),
    }) }],
    loader: async (getAuth) => { await getAuth(); return { baseURL: "https://inference.example/v1", fetch: async (request, init) => Response.json({ destination: String(request), redirect: init?.redirect }) } },
  } })`,
  )
  const approval = inspectOAuthPlugin(entry)[0]
  if (options.approved) writeOAuthApproval(approval)
  const loaded = await PluginLoader.load({
    spec: entry,
    options: undefined,
    deprecated: false,
    source: "npm",
    target: root,
    entry,
  })
  if (!loaded.ok) throw loaded.error
  const create = loaded.value.mod.default as () => Promise<Hooks>
  const hook = protectPluginOAuth(await create(), loaded.value)
  hooks.push(hook)
  return { approval, hook, entry }
}
test("actual imported plugin stays paused without user-owned consent and activates only the exact approved hook", async () => {
  const unapproved = await fixture()
  expect(unapproved.hook.auth?.methods.map((method) => method.type)).toEqual(["api"])
  expect(pluginOAuthAllowed(unapproved.hook.auth!)).toBe(false)
  expect(providerEnabled("github-copilot")).toBe(false)
  const approved = await fixture({ approved: true })
  expect(pluginOAuthAllowed(approved.hook.auth!)).toBe(true)
  expect(pluginOAuthAllowed(unapproved.hook.auth!)).toBe(false)
  expect(providerEnvironmentAllowed("github-copilot")).toBe(false)
  const method = approved.hook.auth!.methods[1]
  if (method.type !== "oauth") throw new Error("Expected approved OAuth")
  const authorization = await method.authorize()
  if (authorization.method !== "code") throw new Error("Expected code")
  const result = await authorization.callback("fixture-code")
  if (result.type !== "success" || !("access" in result)) throw new Error("Expected synthetic OAuth result")
  const credential = { ...result, type: "oauth" as const }
  expect(providerCredentialAllowed("github-copilot", credential)).toBe(true)
  expect(providerCredentialAllowed("github-copilot", { ...credential, metadata: undefined })).toBe(false)
  const options = await approved.hook.auth!.loader!(() => Promise.resolve(credential), { options: {} } as never)
  const send = options.fetch as (url: string, init?: RequestInit) => Promise<Response>
  expect(await (await send("https://inference.example/v1/chat")).json()).toEqual({
    destination: "https://inference.example/v1/chat",
    redirect: "error",
  })
  await expect(send("https://other.example/v1/chat")).rejects.toThrow("unapproved API")
  revokeOAuthApproval(approved.approval.id)
  await expect(send("https://inference.example/v1/chat")).rejects.toThrow("revoked")
  await expect(authorization.callback("fixture-code")).rejects.toThrow("revoked")
  expect(pluginOAuthAllowed(approved.hook.auth!)).toBe(false)
})
test("OAuth results that carry delegated API keys retain binding metadata", async () => {
  const value = await fixture({ approved: true, key: true })
  const method = value.hook.auth!.methods[1]
  if (method.type !== "oauth") throw new Error("Expected OAuth")
  const authorization = await method.authorize()
  if (authorization.method !== "code") throw new Error("Expected code")
  const result = await authorization.callback("fixture-code")
  if (result.type !== "success" || !("key" in result)) throw new Error("Expected delegated key")
  expect(result.metadata?.vector_plugin_oauth).toBe(value.approval.id)
  expect(providerCredentialAllowed("github-copilot", { ...result, type: "api" })).toBe(true)
})
for (const mismatch of ["issuer", "client", "provider"]) {
  test(`rejects ${mismatch} mismatch from actual loaded plugin`, async () => {
    const value = await fixture({ approved: true, mismatch })
    const method = value.hook.auth!.methods[1]
    if (method.type !== "oauth") throw new Error("Expected OAuth")
    if (mismatch === "issuer") {
      await expect(method.authorize()).rejects.toThrow("approved issuer")
      return
    }
    const authorization = await method.authorize()
    if (authorization.method !== "code") throw new Error("Expected code")
    await expect(authorization.callback("fixture-code")).rejects.toThrow("another")
  })
}
test("changing imported plugin code requires new consent and a fresh process", async () => {
  const value = await fixture({ approved: true })
  writeFileSync(value.entry, "export default async () => ({})")
  const loaded = await PluginLoader.load({
    spec: value.entry,
    options: undefined,
    deprecated: false,
    source: "npm",
    target: path.dirname(value.entry),
    entry: value.entry,
  })
  expect(loaded.ok).toBe(false)
  if (!loaded.ok) expect(String(loaded.error)).toContain("Restart Vector")
})

test("one approved plugin cannot receive a different approved plugin's credential", async () => {
  const first = await fixture({ approved: true })
  const second = await fixture({ approved: true })
  const method = second.hook.auth!.methods[1]
  if (method.type !== "oauth") throw new Error("Expected OAuth")
  const authorization = await method.authorize()
  if (authorization.method !== "code") throw new Error("Expected code")
  const result = await authorization.callback("fixture-code")
  if (result.type !== "success" || !("access" in result)) throw new Error("Expected OAuth")
  const credential = { ...result, type: "oauth" as const }
  expect(await first.hook.auth!.loader!(() => Promise.resolve(credential), { options: {} } as never)).toEqual({})
  const ownMethod = first.hook.auth!.methods[1]
  if (ownMethod.type !== "oauth") throw new Error("Expected OAuth")
  const ownAuthorization = await ownMethod.authorize()
  if (ownAuthorization.method !== "code") throw new Error("Expected code")
  const ownResult = await ownAuthorization.callback("fixture-code")
  if (ownResult.type !== "success" || !("access" in ownResult)) throw new Error("Expected OAuth")
  let current = { ...ownResult, type: "oauth" as const }
  const options = await first.hook.auth!.loader!(() => Promise.resolve(current), { options: {} } as never)
  current = credential
  const send = options.fetch as (url: string) => Promise<Response>
  await expect(send("https://inference.example/v1/chat")).rejects.toThrow("credential changed")
})
