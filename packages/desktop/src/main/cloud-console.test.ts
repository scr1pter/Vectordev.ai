import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PublishProjectInput } from "./publish"

const userDataPath = join(tmpdir(), "vector-cloud-console-test")
const stores = new Map<string, Map<string, unknown>>()
// Bun keeps a module mock for the rest of the run, so it carries every export a later test file's imports bind.
const electron = {
  app: { getPath: () => userDataPath },
  shell: { openExternal: async () => {} },
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
  applyEnv,
  cloudProjectScopeKey,
  connectDatabase,
  detectBuildSettings,
  getDatabase,
  listEnv,
  redactCloudLog,
  removeEnv,
  setEnv,
} = await import("./cloud-console")
const { startCloudBridge, stopCloudBridge } = await import("./cloud-bridge")

let project = ""

beforeEach(async () => {
  stores.clear()
  project = await mkdtemp(join(tmpdir(), "vector-cloud-workspace-"))
  delete process.env.VECTOR_CLOUD_URL
  delete process.env.VECTOR_CLOUD_TOKEN
  // Environment values are vault-encrypted at rest, as provider tokens are.
  process.env.VECTOR_CREDENTIAL_KEY = Buffer.alloc(32, 4).toString("base64")
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

  test("encrypts values at rest and moves an older release's plaintext on first read", async () => {
    stores.set(
      "cloud-projects",
      new Map([
        [
          cloudProjectScopeKey(project),
          {
            env: [{ key: "LEGACY_TOKEN", value: "plaintext-fixture-secret" }],
            database: null,
            domains: [],
            build: null,
          },
        ],
      ]),
    )
    expect(listEnv(project)).toEqual([{ key: "LEGACY_TOKEN", value: "plaintext-fixture-secret", visibility: "server" }])
    setEnv(project, undefined, "NEW_SECRET", "new-fixture-secret")
    const stored = JSON.stringify(stores.get("cloud-projects")?.get(cloudProjectScopeKey(project)))
    expect(stored).not.toContain("plaintext-fixture-secret")
    expect(stored).not.toContain("new-fixture-secret")
    expect(stored).toContain('"secret":"v1.')
    expect(listEnv(project).map((item) => item.value)).toEqual(["plaintext-fixture-secret", "new-fixture-secret"])
    expect(redactCloudLog(project, undefined, "token new-fixture-secret leaked")).toBe("token [redacted] leaked")
  })

  test("never stores a server-only value under a browser-visible name", async () => {
    for (const key of ["VITE_STRIPE_KEY", "NEXT_PUBLIC_SECRET", "PUBLIC_TOKEN", "REACT_APP_KEY", "EXPO_PUBLIC_KEY"]) {
      expect(() => setEnv(project, undefined, key, "fixture-secret", "server")).toThrow(
        "puts its value into browser code",
      )
    }
    expect(listEnv(project)).toEqual([])
    setEnv(project, undefined, "STRIPE_SECRET_KEY", "fixture-secret")
    setEnv(project, undefined, "VITE_API_URL", "https://api.fixture.invalid")
    setEnv(project, undefined, "SUPABASE_URL", "https://fixture.supabase.co", "public")
    expect(listEnv(project).map((item) => [item.key, item.visibility])).toEqual([
      ["STRIPE_SECRET_KEY", "server"],
      ["VITE_API_URL", "public"],
      ["SUPABASE_URL", "public"],
    ])
  })

  test("wires public Supabase credentials into the generated Vite browser client", async () => {
    await writeFile(join(project, "package.json"), JSON.stringify({ devDependencies: { vite: "fixture" } }))
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
    // Without a framework that bundles client env, the plain names are written.
    expect(listEnv(project)).toContainEqual({ key: "SUPABASE_ANON_KEY", value: anonKey, visibility: "public" })
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

async function bridgeCommand(
  bridge: { url: string; token: string },
  input: Record<string, unknown>,
  token = bridge.token,
) {
  return fetch(`${bridge.url}/command`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectPath: project, ...input }),
  })
}

describe("cloud bridge publish destination", () => {
  test("reports and uses the linked Vercel project over the authenticated HTTP bridge", async () => {
    seedHost("vercel")
    const published: string[] = []
    const bridge = await startCloudBridge({
      publish: async (input) => {
        published.push(input.target)
        return { ok: true, target: input.target, log: "fixture publication" }
      },
    })
    expect((await bridgeCommand(bridge, { command: "publish" }, "wrong-token")).status).toBe(401)
    expect(published).toEqual([])
    const status = await (await bridgeCommand(bridge, { command: "status" })).json()
    expect(status.configured).toBe(true)
    expect(status.targets).toEqual([{ id: "vercel", label: "Vercel", projectName: "vercel app" }])
    expect(status).not.toHaveProperty("aws")
    expect(JSON.stringify(status)).not.toContain("never-decrypt-fixture")
    expect(await (await bridgeCommand(bridge, { command: "publish" })).json()).toMatchObject({
      ok: true,
      target: "vercel",
    })
    expect(published).toEqual(["vercel"])
  })

  test("publishes a preview unless production is asked for, and says which it made", async () => {
    seedHost("vercel")
    const published: (boolean | undefined)[] = []
    const bridge = await startCloudBridge({
      publish: async (input) => {
        published.push(input.production)
        return { ok: true, target: input.target, log: "", url: "https://fixture.vercel.app" }
      },
    })
    expect(await (await bridgeCommand(bridge, { command: "publish" })).json()).toMatchObject({
      ok: true,
      environment: "preview",
    })
    expect(await (await bridgeCommand(bridge, { command: "publish", production: true })).json()).toMatchObject({
      ok: true,
      environment: "production",
    })
    expect(published).toEqual([false, true])
  })

  test("reports a provider failure without falling back to another destination", async () => {
    seedHost("vercel")
    const published: string[] = []
    const bridge = await startCloudBridge({
      publish: async (input) => {
        published.push(input.target)
        return { ok: false, target: input.target, log: "", error: "fixture provider rejection" }
      },
    })
    expect(await (await bridgeCommand(bridge, { command: "publish" })).json()).toMatchObject({
      ok: false,
      target: "vercel",
      error: "fixture provider rejection",
    })
    expect(published).toEqual(["vercel"])
  })

  test("asks for setup when Vercel is connected but no project is linked", async () => {
    seedHost("vercel", false)
    const published: string[] = []
    const bridge = await startCloudBridge({
      publish: async (input) => {
        published.push(input.target)
        return { ok: true, target: input.target, log: "" }
      },
    })
    // The scrapped hosted publish service is not a destination, even when its
    // variables are still set on this machine.
    process.env.VECTOR_CLOUD_URL = "https://fixture.invalid"
    process.env.VECTOR_CLOUD_TOKEN = "fixture-only-host-token"
    expect(await (await bridgeCommand(bridge, { command: "publish" })).json()).toMatchObject({
      ok: false,
      needsSetup: true,
      targets: [],
    })
    expect(published).toEqual([])
  })

  test("describes what each changing action would touch for the permission prompt", async () => {
    seedHost("vercel")
    setEnv(project, undefined, "API_URL", "https://api.fixture.invalid")
    const bridge = await startCloudBridge()
    const describe = async (input: Record<string, unknown>) =>
      (await bridgeCommand(bridge, { command: "describe", ...input })).json()
    // A publish is a preview unless production is asked for by name.
    expect(await describe({ action: "publish" })).toEqual({
      ok: true,
      scope: {
        provider: "Vercel",
        project: "vercel app",
        environment: "preview",
        summary: "Publish this project to the Vercel project vercel app as a preview. Production does not change.",
      },
    })
    expect((await describe({ action: "publish", production: false })).scope.environment).toBe("preview")
    const production = await describe({ action: "publish", production: true })
    expect(production.scope).toMatchObject({
      environment: "production",
      summary: expect.stringContaining("Production traffic moves to it only if they pass"),
    })
    // Moving production asks every time; a preview may be remembered.
    expect(production.repeatable).toBe(false)
    for (const action of ["prepare_database", "prepare_auth", "apply_migrations"]) {
      expect(await describe({ action })).toMatchObject({ ok: false, needsSetup: true })
    }
    // Creating something the user is billed for asks every time.
    expect(await describe({ action: "create_database", organizationId: "org_1", region: "eu-west-2" })).toMatchObject({
      ok: true,
      repeatable: false,
      scope: {
        provider: "Supabase",
        project: "a new project",
        summary:
          "Create a new Supabase project in organization org_1 in eu-west-2. Supabase bills it to that organization.",
      },
    })
    await connectDatabase(project, undefined, {
      provider: "supabase",
      url: "https://fixtureref.supabase.co",
      anonKey: "sb_publishable_fixture_key",
      projectRef: "fixtureref",
      projectName: "shop-db",
    })
    // A schema change on the production database asks every time; reading the plan does not.
    expect(await describe({ action: "apply_migrations" })).toMatchObject({
      ok: true,
      repeatable: false,
      scope: { provider: "Supabase", project: "shop-db", environment: "production" },
    })
    const dryRun = await describe({ action: "apply_migrations", dryRun: true })
    expect(dryRun.scope.summary).toContain("Nothing changes")
    expect(dryRun).not.toHaveProperty("repeatable")
    expect((await describe({ action: "create_database" })).scope.summary).toContain("nothing new is created")
    const missing = await bridgeCommand(bridge, { command: "describe" })
    expect(missing.status).toBe(400)
    expect(await (await bridgeCommand(bridge, { command: "describe", action: "status" })).json()).toEqual({
      ok: false,
      error: "Choose a Vector Cloud action to describe.",
    })
  })

  test("an agent in a parallel workspace uses its project's cloud scope and its own worktree files", async () => {
    seedHost("vercel")
    setEnv(project, undefined, "PUBLIC_API", "https://api.fixture.invalid")
    const worktree = await mkdtemp(join(tmpdir(), "vector-cloud-worktree-"))
    try {
      await writeFile(join(worktree, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }))
      mkdirSync(join(worktree, "supabase", "migrations"), { recursive: true })
      writeFileSync(join(worktree, "supabase", "migrations", "0001_init.sql"), "create table posts ();")
      const published: PublishProjectInput[] = []
      const bridge = await startCloudBridge({
        workspaces: () => [{ id: "ws-1", name: "Agent 1", sourcePath: project, isolatedPath: worktree }],
        // The second publish is a never-deployed project's first deployment,
        // which Vercel makes production whatever Vector asks for.
        publish: async (input) => {
          published.push(input)
          return {
            ok: true,
            target: input.target,
            log: "",
            url: "https://agent-preview.vercel.app",
            environment: published.length > 1 ? ("production" as const) : ("preview" as const),
          }
        },
      })
      const command = async (input: Record<string, unknown>) =>
        (await bridgeCommand(bridge, { ...input, projectPath: worktree })).json()

      const status = await command({ command: "status" })
      expect(status.targets).toEqual([{ id: "vercel", label: "Vercel", projectName: "vercel app" }])
      expect(await command({ command: "describe", action: "publish" })).toMatchObject({
        ok: true,
        scope: { project: "vercel app", environment: "preview" },
      })
      expect(await command({ command: "publish" })).toMatchObject({
        ok: true,
        nextStep: expect.stringContaining("Merge the workspace into the main project"),
      })
      expect(published).toEqual([
        expect.objectContaining({
          projectPath: worktree,
          scopeProjectPath: project,
          workspaceId: "ws-1",
          workspaceName: "Agent 1",
          production: false,
        }),
      ])
      expect((await command({ command: "publish" })).nextStep).toContain(
        "Vercel made this agent workspace's release production",
      )

      // Migrations are discovered in the worktree, where the agent wrote them,
      // and the database is looked up in the project's scope.
      expect(await command({ command: "apply_migrations", dryRun: true })).toMatchObject({
        ok: false,
        error: "No Supabase project is connected to this project.",
      })
      await connectDatabase(project, undefined, {
        provider: "supabase",
        url: "https://fixtureref.supabase.co",
        anonKey: "sb_publishable_fixture_key",
        projectRef: "fixtureref",
      })
      expect(await command({ command: "prepare_database" })).toMatchObject({ ok: true })
      expect(await readFile(join(worktree, ".env"), "utf8")).toContain("PUBLIC_API=https://api.fixture.invalid")
      expect((await command({ command: "detect_build" })).build.buildCommand).toBe("npm run build")
      expect(listEnv(worktree)).toEqual([])
    } finally {
      await rm(worktree, { recursive: true, force: true })
    }
  })

  test("rejects the removed AWS inventory commands", async () => {
    const bridge = await startCloudBridge()
    for (const command of ["aws_status", "aws_resources"]) {
      const response = await bridgeCommand(bridge, { command })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ ok: false, error: "Unsupported Vector Cloud command." })
    }
  })

  test("ignores a Netlify connection and link saved by an older release", async () => {
    seedHost("netlify")
    const published: string[] = []
    const bridge = await startCloudBridge({
      publish: async (input) => {
        published.push(input.target)
        return { ok: true, target: input.target, log: "" }
      },
    })
    const status = await (await bridgeCommand(bridge, { command: "status" })).json()
    expect(status.targets).toEqual([])
    expect(status.connections.map((item: { provider: string }) => item.provider)).toEqual(["vercel", "supabase"])
    expect(await (await bridgeCommand(bridge, { command: "publish", target: "netlify" })).json()).toMatchObject({
      ok: false,
      needsSetup: true,
    })
    expect(published).toEqual([])
    const { forgetRetiredCloudProviders, listCloudProviderProjectLinks } = await import("./cloud-connections")
    expect(listCloudProviderProjectLinks(project)).toEqual([])
    expect(forgetRetiredCloudProviders()).toBe(1)
    expect(stores.get("cloud-provider-connections")?.get("records")).toEqual([])
    expect(forgetRetiredCloudProviders()).toBe(0)
  })
})
