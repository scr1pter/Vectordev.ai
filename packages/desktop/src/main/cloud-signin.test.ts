import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createHash, webcrypto } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

import { fakeVercel } from "../../test/fake-vercel"
import { MANAGEMENT_TOKEN, startSupabaseFake } from "../../test/supabase-fake"

// One-click sign-in end to end, as the Connections screen runs it: the desktop
// asks the broker which providers are configured, starts a sign-in, opens the
// provider's page, takes the callback page's deep link and finishes through the
// broker's exchange. The broker is the real vectordev.ai route code served on
// 127.0.0.1 with placeholder registrations; only the providers are fakes.

const userDataPath = join(tmpdir(), "vector-cloud-signin-test")
const stores = new Map<string, Map<string, unknown>>()
const opened: string[] = []
// Bun keeps a module mock for the rest of the run, so it carries every export a later test file's imports bind.
const electron = {
  app: { getPath: () => userDataPath },
  shell: {
    openExternal: async (url: string) => {
      opened.push(url)
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}
mock.module("electron", () => ({ default: electron, ...electron }))
mock.module("./store", () => ({
  getStore: (name = "default") => {
    if (!stores.has(name)) stores.set(name, new Map())
    const bucket = stores.get(name)!
    const path = join(userDataPath, name)
    mkdirSync(userDataPath, { recursive: true })
    writeFileSync(path, "", { flag: "a" })
    return {
      get: (key: string) => bucket.get(key),
      set: (key: string, value: unknown) => bucket.set(key, value),
      delete: (key: string) => bucket.delete(key),
      path,
    }
  },
  removeStoreFileIfEmpty: () => undefined,
}))

const {
  connectCloudProvider,
  disconnectCloudProvider,
  getSupabaseManagementToken,
  handleCloudOAuthDeepLinks,
  listCloudProviderConnections,
} = await import("./cloud-connections")
const { listVercelScopes } = await import("./cloud-vercel-projects")
const status = await import("../../../../api/cloud/oauth/status")
const start = await import("../../../../api/cloud/oauth/start")
const { createOAuthCallbackResponse, exchangeOAuthCode } = await import("../../../../api/cloud/oauth/_oauth")

// Placeholder registrations, never real ones.
const REGISTRATION = {
  VECTOR_OAUTH_STATE_SECRET: "vector-oauth-state-secret-for-signin-tests",
  VECTOR_VERCEL_INTEGRATION_SLUG: "vector-fixture",
  VECTOR_VERCEL_CLIENT_ID: "oac_fixture_client",
  VECTOR_VERCEL_CLIENT_SECRET: "fixture-vercel-client-secret",
  VECTOR_SUPABASE_CLIENT_ID: "fixture-supabase-client",
  VECTOR_SUPABASE_CLIENT_SECRET: "fixture-supabase-client-secret",
}

type TokenRequest = { url: string; form: URLSearchParams; authorization?: string }

let broker: ReturnType<typeof Bun.serve>
let vercel: ReturnType<typeof fakeVercel>
let supabase: Awaited<ReturnType<typeof startSupabaseFake>>
const tokenRequests: TokenRequest[] = []
const saved = new Map<string, string | undefined>()

// The provider token endpoints the broker's exchange calls: Supabase checks the
// PKCE verifier against the challenge the authorize URL carried.
let challenge = ""
async function providerTokenEndpoint(input: string | URL | Request, init?: RequestInit) {
  const url = String(input)
  const form = new URLSearchParams(String(init?.body ?? ""))
  tokenRequests.push({ url, form, authorization: new Headers(init?.headers).get("authorization") ?? undefined })
  if (url === "https://api.vercel.com/v2/oauth/access_token") {
    if (form.get("code") !== "vercel-fixture-code") return Response.json({ error: "invalid_grant" }, { status: 400 })
    return Response.json({ access_token: vercel.token, token_type: "Bearer", team_id: "team_1" })
  }
  if (url === "https://api.supabase.com/v1/oauth/token") {
    const verifier = form.get("code_verifier") ?? ""
    if (
      form.get("code") !== "supabase-fixture-code" ||
      createHash("sha256").update(verifier).digest("base64url") !== challenge
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 })
    }
    return Response.json({ access_token: MANAGEMENT_TOKEN, refresh_token: "fixture-refresh-token", expires_in: 3600 })
  }
  return Response.json({ error: `unexpected ${url}` }, { status: 500 })
}

// What the desktop reaches: the broker over real HTTP, and each provider's API
// on its fake.
async function desktopRequest(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.host === new URL(broker.url).host) return fetch(input, init)
  if (url.hostname === "api.vercel.com") return fetch(`${vercel.url}${url.pathname}${url.search}`, init)
  return supabase.request(input, init)
}

beforeEach(async () => {
  stores.clear()
  opened.length = 0
  tokenRequests.length = 0
  challenge = ""
  vercel = fakeVercel()
  supabase = await startSupabaseFake()
  broker = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/api/cloud/oauth/status") return status.GET(request)
      if (path === "/api/cloud/oauth/start") return start.POST(request)
      if (path === "/api/cloud/oauth/callback-supabase") return createOAuthCallbackResponse("supabase", request.url)
      if (path === "/api/cloud/oauth/callback-vercel") return createOAuthCallbackResponse("vercel", request.url)
      if (path === "/api/cloud/oauth/exchange") {
        const body = await request.json()
        const token = await exchangeOAuthCode(body, request.url, process.env, providerTokenEndpoint)
        return Response.json({ ok: true, ...token })
      }
      return Response.json({ ok: false, error: `unexpected ${path}` }, { status: 404 })
    },
  })
  const env = {
    ...REGISTRATION,
    VECTOR_OAUTH_PUBLIC_URL: new URL(broker.url).origin,
    VECTOR_OAUTH_BROKER_URL: new URL("/api/cloud/oauth", broker.url).toString(),
    VECTOR_VERCEL_API_URL: vercel.url,
    VECTOR_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64"),
  }
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key])
    process.env[key] = value
  }
})

afterEach(async () => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
  await broker.stop(true)
  await vercel.stop()
  await supabase.stop()
  await rm(userDataPath, { recursive: true, force: true })
})

async function openedPage() {
  for (let attempt = 0; attempt < 200 && !opened.length; attempt += 1) await Bun.sleep(5)
  const page = opened.shift()
  if (!page) throw new Error("Vector did not open the provider's sign-in page.")
  return new URL(page)
}

// The broker's callback page, as a browser runs it: its script, or for
// Supabase its link, is the deep link back to the desktop.
async function callbackDeepLink(callback: URL) {
  const html = await (await fetch(callback)).text()
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ""
  const link = script.match(/const link=("[^"]*")/)?.[1]
  if (link) return JSON.parse(link) as string
  const output = { link: "" }
  await runInNewContext(script, {
    location: callback,
    URL,
    URLSearchParams,
    crypto: webcrypto,
    TextEncoder,
    atob,
    btoa,
    document: {
      getElementById: () => ({
        set textContent(_value: string) {},
        setAttribute(_name: string, value: string) {
          output.link = value
        },
      }),
    },
    setTimeout(callback: () => void) {
      callback()
    },
  })
  return output.link
}

describe("one-click sign-in through Vector's broker", () => {
  test("offers sign-in only for a provider the broker has registrations for", async () => {
    delete process.env.VECTOR_VERCEL_CLIENT_SECRET
    const connections = await listCloudProviderConnections()
    expect(connections.find((item) => item.provider === "supabase")).toMatchObject({
      configured: true,
      callbackUrl: `${new URL(broker.url).origin}/api/cloud/oauth/callback-supabase`,
    })
    expect(connections.find((item) => item.provider === "vercel")).toMatchObject({
      configured: false,
      manualTokenSupported: true,
      detail: expect.stringContaining("personal access token"),
    })
  })

  test("signs in to Supabase with PKCE and keeps only an encrypted token", async () => {
    const pending = connectCloudProvider("supabase")
    const authorize = await openedPage()
    expect(authorize.origin + authorize.pathname).toBe("https://api.supabase.com/v1/oauth/authorize")
    expect(authorize.searchParams.get("client_id")).toBe(REGISTRATION.VECTOR_SUPABASE_CLIENT_ID)
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${new URL(broker.url).origin}/api/cloud/oauth/callback-supabase`,
    )
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
    challenge = authorize.searchParams.get("code_challenge") ?? ""

    // Supabase sends the browser back to the broker's callback.
    const callback = new URL(authorize.searchParams.get("redirect_uri")!)
    callback.search = new URLSearchParams({
      code: "supabase-fixture-code",
      state: authorize.searchParams.get("state")!,
    }).toString()
    const link = await callbackDeepLink(callback)
    expect(link.startsWith("vector://cloud/oauth?")).toBe(true)

    // Another app answering on the same scheme cannot finish or cancel it.
    const forged = new URL(link)
    forged.searchParams.set("state", "forged-state")
    expect(await handleCloudOAuthDeepLinks([forged.toString()], desktopRequest)).toEqual([])
    expect(await handleCloudOAuthDeepLinks([link], desktopRequest)).toEqual([])

    expect(await pending).toMatchObject({ provider: "supabase", configured: true, connected: true, account: "Solo" })
    const exchange = tokenRequests.find((item) => item.url === "https://api.supabase.com/v1/oauth/token")
    expect(exchange?.form.get("redirect_uri")).toBe(callback.origin + callback.pathname)
    expect(exchange?.authorization).toBe(
      `Basic ${Buffer.from(`${REGISTRATION.VECTOR_SUPABASE_CLIENT_ID}:${REGISTRATION.VECTOR_SUPABASE_CLIENT_SECRET}`).toString("base64")}`,
    )
    expect(await getSupabaseManagementToken(desktopRequest)).toBe(MANAGEMENT_TOKEN)
    const vault = JSON.stringify([...stores.values()].map((bucket) => [...bucket.entries()]))
    expect(vault).not.toContain(MANAGEMENT_TOKEN)
    expect(vault).not.toContain("fixture-refresh-token")
    expect(vault).not.toContain(REGISTRATION.VECTOR_SUPABASE_CLIENT_SECRET)
  })

  test("signs in to Vercel on the installed team, encrypted to this desktop, and uninstalls on disconnect", async () => {
    const pending = connectCloudProvider("vercel")
    const install = await openedPage()
    expect(install.origin + install.pathname).toBe(
      `https://vercel.com/integrations/${REGISTRATION.VECTOR_VERCEL_INTEGRATION_SLUG}/new`,
    )

    // Vercel sends the browser back with the team the user installed on.
    const callback = new URL("/api/cloud/oauth/callback-vercel", broker.url)
    callback.search = new URLSearchParams({
      code: "vercel-fixture-code",
      state: install.searchParams.get("state")!,
      teamId: "team_1",
      configurationId: "icfg_fixture",
    }).toString()
    const link = await callbackDeepLink(callback)
    expect(new URL(link).searchParams.has("encrypted")).toBe(true)
    expect(link).not.toContain("vercel-fixture-code")
    expect(await handleCloudOAuthDeepLinks([link], desktopRequest)).toEqual([])

    expect(await pending).toMatchObject({ provider: "vercel", configured: true, connected: true, account: "ada" })
    const exchange = tokenRequests.find((item) => item.url === "https://api.vercel.com/v2/oauth/access_token")
    expect(exchange?.form.get("client_secret")).toBe(REGISTRATION.VECTOR_VERCEL_CLIENT_SECRET)
    expect((await listVercelScopes()).scopes).toEqual([{ kind: "team", teamId: "team_1", slug: "acme", name: "Acme" }])
    expect(JSON.stringify([...stores.values()].map((bucket) => [...bucket.entries()]))).not.toContain(vercel.token)

    vercel.state.configurations.set("icfg_fixture", "team_1")
    expect(await disconnectCloudProvider("vercel")).toMatchObject({ revoked: true })
    expect(vercel.state.configurations.has("icfg_fixture")).toBe(false)
  })
})
