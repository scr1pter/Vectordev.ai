import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const userDataPath = join(tmpdir(), "vector-cloud-console-test")
const stores = new Map<string, Map<string, unknown>>()
const electron = { app: { getPath: () => userDataPath }, shell: { openExternal: async () => {} } }
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
  applyEnv,
  cloudProjectScopeKey,
  connectDatabase,
  detectBuildSettings,
  getDatabase,
  listEnv,
  removeEnv,
  setEnv,
} = await import("./cloud-console")
const { startCloudBridge, stopCloudBridge } = await import("./cloud-bridge")
const { syncCloudProviderEnvironment } = await import("./cloud-connections")
const { encryptCloudCredential } = await import("./cloud-credential-vault")

let project = ""

beforeEach(async () => {
  stores.clear()
  project = await mkdtemp(join(tmpdir(), "vector-cloud-workspace-"))
  delete process.env.VECTOR_CLOUD_URL
  delete process.env.VECTOR_CLOUD_TOKEN
  delete process.env.VECTOR_CREDENTIAL_KEY
})

afterEach(async () => {
  await stopCloudBridge()
  await rm(project, { recursive: true, force: true })
  await rm(userDataPath, { recursive: true, force: true })
  delete process.env.VECTOR_CLOUD_URL
  delete process.env.VECTOR_CLOUD_TOKEN
})

describe("managed cloud environment", () => {
  test("preserves user lines, removes the last managed value, and keeps files private", async () => {
    await writeFile(join(project, ".env"), "USER_OWNED=keep\n", { mode: 0o644 })
    setEnv(project, undefined, "privateToken", "fixture secret # value")
    await applyEnv(project)
    expect(await readFile(join(project, ".env"), "utf8")).toBe(
      'USER_OWNED=keep\n\n# --- Vector-managed (do not edit below) ---\nprivateToken="fixture secret # value"\n',
    )
    if (process.platform !== "win32") expect((await lstat(join(project, ".env"))).mode & 0o777).toBe(0o600)
    removeEnv(project, undefined, "privateToken")
    await applyEnv(project)
    expect(await readFile(join(project, ".env"), "utf8")).toBe(
      "USER_OWNED=keep\n\n# --- Vector-managed (do not edit below) ---\n",
    )
    expect((await readdir(project)).filter((name) => name.startsWith(".env.vector-"))).toEqual([])
  })

  test("creates a private environment file without disclosing values in its result", async () => {
    setEnv(project, undefined, "SECRET", "fixture-only-secret")
    expect(await applyEnv(project)).toEqual({ written: ".env" })
    expect(await readFile(join(project, ".env"), "utf8")).toContain("SECRET=fixture-only-secret")
    if (process.platform !== "win32") expect((await lstat(join(project, ".env"))).mode & 0o777).toBe(0o600)
  })

  test("rejects a symlink without touching its target", async () => {
    const outside = await mkdtemp(join(tmpdir(), "vector-cloud-outside-"))
    try {
      const destination = join(outside, "private.env")
      await writeFile(destination, "OUTSIDE=unchanged\n")
      await symlink(destination, join(project, ".env"), "file")
      setEnv(project, undefined, "SECRET", "must-not-write")
      await expect(applyEnv(project)).rejects.toThrow("not a symbolic link")
      expect(await readFile(destination, "utf8")).toBe("OUTSIDE=unchanged\n")
      expect((await lstat(join(project, ".env"))).isSymbolicLink()).toBe(true)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("rejects multiline values before changing the existing file", async () => {
    await writeFile(join(project, ".env"), "KEEP=yes\n")
    setEnv(project, undefined, "SECRET", "first\nINJECTED=second")
    await expect(applyEnv(project)).rejects.toThrow("contains a line break")
    expect(await readFile(join(project, ".env"), "utf8")).toBe("KEEP=yes\n")
  })

  test("wires public Supabase credentials into the generated Vite browser client", async () => {
    await connectDatabase(project, undefined, {
      provider: "supabase",
      url: "https://fixture-project.supabase.co",
      anonKey: "sb_publishable_fixture_key",
    })
    const { loadEnv } = await import("vite")
    expect(loadEnv("development", project, "VITE_")).toEqual({
      VITE_SUPABASE_URL: "https://fixture-project.supabase.co",
      VITE_SUPABASE_ANON_KEY: "sb_publishable_fixture_key",
    })
    expect(await readFile(join(project, "src/lib/supabase.js"), "utf8")).toContain(
      "import.meta.env.VITE_SUPABASE_ANON_KEY",
    )
    expect(await readFile(join(project, ".env"), "utf8")).not.toContain("service_role")
  })

  test("preserves literal dollars and backslashes through the real Vite environment parser", async () => {
    await writeFile(join(project, "package.json"), JSON.stringify({ devDependencies: { vite: "fixture" } }))
    await writeFile(join(project, ".env"), "VECTOR_CLOUD_FIXTURE_EXPANSION=must-not-substitute\n")
    const values = {
      VITE_FIXTURE_DOLLAR: "fixture-$VECTOR_CLOUD_FIXTURE_EXPANSION-${VECTOR_CLOUD_UNSET_9fde:-fallback}-tail",
      VITE_FIXTURE_SLASH: String.raw`C:\nested\runtime\$VECTOR_CLOUD_FIXTURE_EXPANSION\tail`,
      VITE_FIXTURE_QUOTES: String.raw`quote' and "double" \n remains literal $5`,
      VITE_FIXTURE_TICKS: 'tick` with a double" and $literal',
    }
    for (const [key, value] of Object.entries(values)) setEnv(project, undefined, key, value)
    await applyEnv(project)
    const { loadEnv } = await import("vite")
    expect(loadEnv("development", project, "VITE_FIXTURE_")).toEqual(values)
    await detectBuildSettings(project)
    await rm(join(project, "package.json"))
    await applyEnv(project)
    expect(loadEnv("development", project, "VITE_FIXTURE_")).toEqual(values)
  })

  test("keeps generic project serialization unchanged without positive Vite evidence", async () => {
    const value = String.raw`fixture-$VARIABLE-\tail`
    setEnv(project, undefined, "GENERIC_VALUE", value)
    await applyEnv(project)
    expect(await readFile(join(project, ".env"), "utf8")).toContain('GENERIC_VALUE="fixture-$VARIABLE-\\\\tail"')
  })

  test("refuses an unrepresentable Vite value before replacing the existing environment", async () => {
    await writeFile(join(project, "package.json"), JSON.stringify({ dependencies: { vite: "fixture" } }))
    await writeFile(join(project, ".env"), "KEEP=unchanged\n")
    setEnv(project, undefined, "VITE_VALUE", "all quotes: ' \" ` # $literal")
    await expect(applyEnv(project)).rejects.toThrow("cannot be written literally for Vite")
    expect(await readFile(join(project, ".env"), "utf8")).toBe("KEEP=unchanged\n")
    expect((await readdir(project)).filter((name) => name.startsWith(".env.vector-"))).toEqual([])
  })

  test("only exposes Supabase anon JWTs, never service, session, management or arbitrary keys", async () => {
    const jwt = (payload: unknown) =>
      `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
    for (const anonKey of [
      "sb_secret_fixture",
      "sbp_management_fixture",
      "arbitrary-token",
      jwt({ iss: "supabase", ref: "fixture", role: "service_role" }),
      jwt({ iss: "supabase", ref: "fixture", role: "authenticated" }),
      jwt({ iss: "unrelated", ref: "fixture", role: "anon" }),
    ]) {
      await expect(
        connectDatabase(project, undefined, {
          provider: "supabase",
          url: "https://fixture.supabase.co",
          anonKey,
        }),
      ).rejects.toThrow("publishable key or an anon public key")
      expect(listEnv(project)).toEqual([])
      expect(getDatabase(project)).toBeNull()
    }
    const anonKey = jwt({ iss: "supabase", ref: "fixture", role: "anon" })
    await connectDatabase(project, undefined, { provider: "supabase", url: "https://fixture.supabase.co", anonKey })
    expect(listEnv(project)).toContainEqual({ key: "VITE_SUPABASE_ANON_KEY", value: anonKey })
  })
})

function seedHost(provider: "vercel" | "netlify", linked = true) {
  const records = stores.get("cloud-provider-connections")?.get("records")
  stores.set(
    "cloud-provider-connections",
    new Map([
      [
        "records",
        [
          ...(Array.isArray(records) ? records : []),
          { provider, accessToken: "never-decrypt-fixture", account: "fixture-account", connectedAt: "2026-01-01" },
        ],
      ],
    ]),
  )
  if (!linked) return
  const key = cloudProjectScopeKey(project)
  const links = stores.get("cloud-provider-links")?.get(key)
  stores.set(
    "cloud-provider-links",
    new Map([
      [
        key,
        [
          ...(Array.isArray(links) ? links : []),
          { provider, projectId: `${provider}-project`, projectName: `${provider} app`, linkedAt: "2026-01-01" },
        ],
      ],
    ]),
  )
}

describe("cloud bridge publish target resolution", () => {
  test("reports and uses the sole linked host over the authenticated HTTP bridge", async () => {
    seedHost("vercel")
    const published: string[] = []
    const bridge = await startCloudBridge({
      publish: async (input) => {
        published.push(input.target)
        return { ok: true, target: input.target, log: "fixture publication" }
      },
      awsStatus: async () => {
        throw new Error("fixture has no AWS")
      },
    })
    const command = async (input: Record<string, unknown>, token = bridge.token) =>
      fetch(`${bridge.url}/command`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ projectPath: project, ...input }),
      })
    expect((await command({ command: "publish" }, "wrong-token")).status).toBe(401)
    expect(published).toEqual([])
    const status = await (await command({ command: "status" })).json()
    expect(status.configured).toBe(true)
    expect(status.targets).toEqual([{ id: "vercel", label: "Vercel", projectName: "vercel app" }])
    expect(JSON.stringify(status)).not.toContain("never-decrypt-fixture")
    expect(await (await command({ command: "publish" })).json()).toMatchObject({ ok: true, target: "vercel" })
    expect(published).toEqual(["vercel"])
  })

  test("requires a choice for multiple linked hosts and never falls back after an explicit failure", async () => {
    seedHost("vercel")
    seedHost("netlify")
    const published: string[] = []
    const bridge = await startCloudBridge({
      publish: async (input) => {
        published.push(input.target)
        return { ok: false, target: input.target, log: "", error: "fixture provider rejection" }
      },
    })
    const command = async (target?: string) =>
      (
        await fetch(`${bridge.url}/command`, {
          method: "POST",
          headers: { authorization: `Bearer ${bridge.token}` },
          body: JSON.stringify({ command: "publish", projectPath: project, target }),
        })
      ).json()
    expect(await command()).toMatchObject({
      ok: false,
      needsChoice: true,
      targets: [{ id: "vercel" }, { id: "netlify" }],
    })
    expect(published).toEqual([])
    expect(await command("vercel")).toMatchObject({ ok: false, target: "vercel", error: "fixture provider rejection" })
    expect(published).toEqual(["vercel"])
  })

  test("ignores unlinked connections, and includes configured standalone hosting in choices", async () => {
    seedHost("vercel", false)
    const published: string[] = []
    const bridge = await startCloudBridge({
      publish: async (input) => {
        published.push(input.target)
        return { ok: true, target: input.target, log: "" }
      },
    })
    const command = async () =>
      (
        await fetch(`${bridge.url}/command`, {
          method: "POST",
          headers: { authorization: `Bearer ${bridge.token}` },
          body: JSON.stringify({ command: "publish", projectPath: project }),
        })
      ).json()
    expect(await command()).toMatchObject({ ok: false, needsSetup: true, targets: [] })
    process.env.VECTOR_CLOUD_URL = "https://fixture.invalid"
    process.env.VECTOR_CLOUD_TOKEN = "fixture-only-host-token"
    expect(await command()).toMatchObject({ ok: true, target: "vector-cloud" })
    seedHost("netlify")
    expect(await command()).toMatchObject({
      ok: false,
      needsChoice: true,
      targets: [{ id: "vector-cloud" }, { id: "netlify" }],
    })
    expect(published).toEqual(["vector-cloud"])
  })
})

describe("Vercel environment sync", () => {
  test.each([0, 1, 2])(
    "handles HTTP 201 with %i rejected variables without leaking values or retrying",
    async (rejected) => {
      process.env.VECTOR_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64")
      seedHost("vercel")
      stores.get("cloud-provider-connections")!.set("records", [
        {
          provider: "vercel",
          accessToken: encryptCloudCredential("fixture-vercel-token"),
          connectedAt: "2026-01-01",
        },
      ])
      const variables = [
        { key: "NEW_KEY", value: "private-fixture-value-one" },
        { key: "EXISTING_KEY", value: "private-fixture-value-two" },
      ]
      for (const variable of variables) setEnv(project, undefined, variable.key, variable.value)
      const requests: string[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requests.push(request.url)
          expect(request.method).toBe("POST")
          expect(request.headers.get("authorization")).toBe("Bearer fixture-vercel-token")
          expect(await request.json()).toEqual(
            variables.map((variable) => ({
              ...variable,
              type: "encrypted",
              target: ["production", "preview", "development"],
              comment: "Synced by Vector",
            })),
          )
          return Response.json(
            {
              created: variables.slice(0, 2 - rejected),
              failed: variables
                .slice(0, rejected)
                .map((variable) => ({ error: { message: variable.value, key: variable.key } })),
            },
            { status: 201 },
          )
        },
      })
      try {
        const result = await syncCloudProviderEnvironment(project, undefined, "vercel", (input, init) => {
          expect(String(input)).toBe("https://api.vercel.com/v10/projects/vercel-project/env?upsert=true")
          return fetch(server.url, init)
        }).then(
          (report) => ({ report, error: "" }),
          (error: Error) => ({ report: undefined, error: error.message }),
        )
        expect(requests).toHaveLength(1)
        if (rejected) {
          expect(result.report).toBeUndefined()
          expect(result.error).toContain(`Vercel rejected ${rejected}`)
          expect(result.error).toContain("Some variables may already be updated")
          expect(result.error).toContain("owned outside this integration")
        } else {
          expect(result.report).toMatchObject({ provider: "vercel", projectId: "vercel-project", changed: 2 })
          expect(result.error).toBe("")
        }
        expect(JSON.stringify(result)).not.toContain("private-fixture-value")
        expect(JSON.stringify(result)).not.toContain("fixture-vercel-token")
        expect(listEnv(project)).toEqual(variables)
      } finally {
        await server.stop(true)
        delete process.env.VECTOR_CREDENTIAL_KEY
      }
    },
  )
})
