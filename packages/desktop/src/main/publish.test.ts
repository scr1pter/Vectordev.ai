import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fakeVercel } from "../../test/fake-vercel"

// publish reaches electron-store through cloud-console and electron's shell
// through cloud-connections, so both are mocked before it is imported.
const userDataPath = join(tmpdir(), "vector-publish-test")
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
const stores = new Map<string, Map<string, unknown>>()
mock.module("./store", () => ({
  getStore: (name = "default") => {
    if (!stores.has(name)) stores.set(name, new Map())
    const bucket = stores.get(name)!
    return {
      get: (key: string) => bucket.get(key),
      set: (key: string, value: unknown) => {
        mkdirSync(userDataPath, { recursive: true })
        writeFileSync(join(userDataPath, name), "", { flag: "a" })
        bucket.set(key, value)
      },
      delete: (key: string) => bucket.delete(key),
      path: join(userDataPath, name),
    }
  },
  removeStoreFileIfEmpty: () => undefined,
}))

const { checkAllDeploymentHealth, checkDeploymentHealth, publishProject, runVercel, VERCEL_CLI_VERSION } = await import(
  "./publish"
)
const { cloudProjectScopeKey, listDeployments, setBuildSettings, setEnv } = await import("./cloud-console")
const { encryptCloudCredential } = await import("./cloud-credential-vault")

let directory = ""

beforeEach(async () => {
  stores.clear()
  process.env.VECTOR_CREDENTIAL_KEY = Buffer.alloc(32, 6).toString("base64")
  directory = await mkdtemp(join(tmpdir(), "vector-publish-cli-"))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

// A stand-in for the Vercel CLI that echoes its token back in two separate
// writes, so the token arrives split across output chunks.
async function tokenEchoCli() {
  const path = join(directory, "vercel")
  await writeFile(
    path,
    [
      "#!/bin/sh",
      'printf "token-set=%s\\n" "${VERCEL_TOKEN:+yes}"',
      'printf "auth %s" "$(printf %s "$VERCEL_TOKEN" | cut -c1-10)"',
      "sleep 0.2",
      'printf "%s\\n" "$(printf %s "$VERCEL_TOKEN" | cut -c11-)"',
      'printf "args %s\\n" "$*"',
      'printf "Preview: https://fixture-app-abc123.vercel.app\\n"',
    ].join("\n"),
  )
  await chmod(path, 0o755)
  return path
}

describe.skipIf(process.platform === "win32")("Vercel CLI runs", () => {
  test("give the CLI the token but never stream, log or return it", async () => {
    const token = "fixtureVercelToken0123456789"
    const chunks: string[] = []
    const result = await runVercel({
      command: [await tokenEchoCli()],
      args: ["--yes", "--project", "prj_fixture"],
      cwd: directory,
      token,
      onOutput: (output) => chunks.push(output),
    })
    expect(result.ok).toBe(true)
    expect(result.log).toContain("token-set=yes")
    expect(result.log).toContain("auth [redacted]")
    expect(result.log).toContain("args --yes --project prj_fixture")
    expect(result.log).not.toContain(token)
    expect(result.log).not.toContain(token.slice(0, 10))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join("")).toBe(result.log)
    expect(chunks.join("")).not.toContain(token)
  })

  test("set no token when the user signed in with the CLI instead", async () => {
    const result = await runVercel({ command: [await tokenEchoCli()], args: [], cwd: directory })
    expect(result.log).toContain("token-set=\n")
  })
})

// The fake CLI prints its arguments and the two variables that pick the
// project, then a deployment URL the fake Vercel API knows, as `vercel deploy`
// prints the deployment URL on stdout (https://vercel.com/docs/cli/deploy).
async function fakeDeployCli(url: string) {
  const path = join(directory, "vercel-deploy")
  await writeFile(
    path,
    [
      "#!/bin/sh",
      'printf "args %s\\n" "$*"',
      'printf "org=%s project=%s\\n" "$VERCEL_ORG_ID" "$VERCEL_PROJECT_ID"',
      `printf "${url}\\n"`,
    ].join("\n"),
  )
  await chmod(path, 0o755)
  return path
}

describe.skipIf(process.platform === "win32")("publishing a project", () => {
  let api: ReturnType<typeof fakeVercel>
  let project = ""

  beforeEach(async () => {
    api = fakeVercel()
    process.env.VECTOR_VERCEL_API_URL = api.url
    project = await mkdtemp(join(tmpdir(), "vector-publish-project-"))
    await writeFile(join(project, "index.html"), "<!doctype html><h1>Shop</h1>\n")
    stores.set(
      "cloud-provider-connections",
      new Map([
        [
          "records",
          [{ provider: "vercel", accessToken: encryptCloudCredential(api.token), connectedAt: "2026-10-01" }],
        ],
      ]),
    )
  })

  afterEach(async () => {
    await api.stop()
    delete process.env.VECTOR_VERCEL_API_URL
    await rm(project, { recursive: true, force: true })
  })

  function linkProject(teamId?: string, overrides: Parameters<typeof api.addProject>[0] = { name: "shop" }) {
    const remote = api.addProject({ ...overrides, teamId })
    stores.set(
      "cloud-provider-links",
      new Map([
        [
          cloudProjectScopeKey(project),
          [
            {
              provider: "vercel",
              projectId: remote.id,
              projectName: remote.name,
              accountId: teamId ?? "user_1",
              teamId,
              linkedAt: "2026-10-01",
            },
          ],
        ],
      ]),
    )
    return remote
  }

  function checks(input: { health: boolean; browser: boolean }) {
    setBuildSettings(project, undefined, {
      framework: "Static",
      packageManager: "static",
      installCommand: "",
      testCommand: "",
      buildCommand: "",
      outputDirectory: ".",
      nodeVersion: "",
      healthPath: "/",
      requiredChecks: { test: false, secrets: true, ...input },
    })
  }

  // Vercel API calls go to the fake API; anything on *.vercel.app is the
  // deployed site, answered by `site`.
  function routed(site: (url: URL, headers: Headers) => Response) {
    return async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname.endsWith(".vercel.app") || url.hostname.endsWith(".example")) {
        return site(url, new Headers(init?.headers))
      }
      return fetch(input, init)
    }
  }

  test("publishes a preview with the pinned CLI, the linked project and no production flags", async () => {
    const remote = linkProject("team_1")
    api.addDeployment({ projectId: remote.id, url: "shop-abc123.vercel.app", target: "production", uid: "dpl_first" })
    remote.productionId = "dpl_first"
    const preview = api.addDeployment({ projectId: remote.id, url: "shop-preview1.vercel.app", uid: "dpl_preview" })
    checks({ health: true, browser: true })
    const page = "<!doctype html>\n<html><body><h1>Shop</h1></body></html>\n"
    await writeFile(join(project, "index.html"), page)
    const cli = await fakeDeployCli(`https://${preview.url}`)
    const browsed: string[] = []
    const result = await publishProject({ projectPath: project, target: "vercel" }, undefined, {
      command: [cli],
      request: routed(() => new Response("ok")),
      browserCheck: async (url) => {
        browsed.push(url)
        return { ok: true, details: "Rendered.", output: "", durationMs: 1 }
      },
    })
    expect(result).toMatchObject({
      ok: true,
      environment: "preview",
      url: "https://shop-preview1.vercel.app/",
      providerDeploymentId: "dpl_preview",
    })
    expect(result.log).toContain("args deploy --yes\n")
    expect(result.log).toContain(`org=team_1 project=${remote.id}`)
    expect(result.log).not.toContain(api.token)
    expect(browsed).toEqual(["https://shop-preview1.vercel.app"])
    expect(api.requests("POST").some((item) => item.path.includes("/promote/"))).toBe(false)
    expect(remote.productionId).toBe("dpl_first")
    expect(await readFile(join(project, "index.html"), "utf8")).toBe(page)
    expect((await readdir(project)).sort()).toEqual(["index.html"])
    expect(listDeployments(project)).toEqual([
      expect.objectContaining({
        environment: "preview",
        releaseStatus: "preview",
        providerDeploymentId: "dpl_preview",
      }),
    ])
    expect(VERCEL_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test("builds production without moving domains, checks it, then promotes it", async () => {
    const remote = linkProject()
    api.addDeployment({ projectId: remote.id, uid: "dpl_old", target: "production" })
    remote.productionId = "dpl_old"
    const staged = api.addDeployment({
      projectId: remote.id,
      uid: "dpl_new",
      url: "shop-new.vercel.app",
      target: "production",
    })
    checks({ health: true, browser: false })
    const order: string[] = []
    const result = await publishProject({ projectPath: project, target: "vercel", production: true }, undefined, {
      command: [await fakeDeployCli(`https://${staged.url}`)],
      sleep: async () => {},
      request: routed((url) => {
        order.push(`check ${url.host}`)
        return new Response("ok")
      }),
    })
    expect(result).toMatchObject({
      ok: true,
      environment: "production",
      productionUrl: "https://shop.vercel.app",
      url: "https://shop.vercel.app",
    })
    expect(result.log).toContain("args deploy --yes --prod --skip-domain")
    expect(order).toEqual(["check shop-new.vercel.app"])
    expect(remote.productionId).toBe("dpl_new")
    expect(listDeployments(project)[0]).toMatchObject({
      releaseStatus: "current",
      productionUrl: "https://shop.vercel.app/",
    })
  })

  test("keeps production where it is while the linked Supabase project fails its security check", async () => {
    const remote = linkProject()
    api.addDeployment({ projectId: remote.id, uid: "dpl_old", target: "production" })
    remote.productionId = "dpl_old"
    const staged = api.addDeployment({
      projectId: remote.id,
      uid: "dpl_new",
      url: "shop-new.vercel.app",
      target: "production",
    })
    stores.set(
      "cloud-projects",
      new Map([
        [
          cloudProjectScopeKey(project),
          {
            env: [],
            domains: [],
            build: null,
            database: {
              provider: "supabase",
              url: "https://fixtureref.supabase.co",
              anonKey: "sb_publishable_fixture_key",
              projectRef: "fixtureref",
              projectName: "shop-db",
              connectedAt: "2026-10-01",
            },
          },
        ],
      ]),
    )
    checks({ health: true, browser: false })
    // Supabase is linked but not connected here, so only the local scan runs;
    // a service_role key in a public variable is enough to stop the promotion.
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signaturesignature`
    setEnv(project, undefined, "VITE_SUPABASE_KEY", jwt, "public")
    const events: string[] = []
    const result = await publishProject(
      { projectPath: project, target: "vercel", production: true, runId: "run-1" },
      (event) => events.push(`${event.stage}:${event.level}`),
      {
        command: [await fakeDeployCli(`https://${staged.url}`)],
        sleep: async () => {},
        request: routed(() => new Response("ok")),
      },
    )
    expect(result).toMatchObject({
      ok: false,
      errorCode: "checks_failed",
      url: "https://shop-new.vercel.app/",
      providerDeploymentId: "dpl_new",
      environment: "preview",
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "supabase-security", status: "failed", required: true }),
      ]),
    })
    expect(result.error).toContain("The Supabase security check failed, so production was not moved to dpl_new.")
    expect(JSON.stringify(result)).not.toContain(jwt)
    expect(remote.productionId).toBe("dpl_old")
    expect(api.requests("POST").some((item) => item.path.includes("/promote/"))).toBe(false)
    expect(events).toContain("checking:error")
    expect(events.at(-1)).toBe("failed:error")
    expect(listDeployments(project)[0]).toMatchObject({ releaseStatus: "preview", providerDeploymentId: "dpl_new" })
  })

  test("a protected preview is reported as protected, not as a failed release", async () => {
    const remote = linkProject(undefined, { name: "shop", ssoProtection: { deploymentType: "preview" } })
    api.addDeployment({ projectId: remote.id, uid: "dpl_first", target: "production" })
    remote.productionId = "dpl_first"
    const preview = api.addDeployment({ projectId: remote.id, uid: "dpl_p", url: "shop-p.vercel.app" })
    checks({ health: true, browser: true })
    const result = await publishProject({ projectPath: project, target: "vercel" }, undefined, {
      command: [await fakeDeployCli(`https://${preview.url}`)],
      request: routed(
        () =>
          new Response("Authentication Required", { status: 401, headers: { "set-cookie": "_vercel_sso_nonce=n" } }),
      ),
      browserCheck: async () => {
        throw new Error("a protected deployment is not rendered")
      },
    })
    expect(result).toMatchObject({ ok: true, protectedChecks: "skipped", environment: "preview" })
    expect(result.checks?.filter((check) => check.type === "health" || check.type === "browser")).toEqual([
      expect.objectContaining({
        type: "health",
        status: "skipped",
        details: expect.stringContaining("Protection Bypass"),
      }),
      expect.objectContaining({ type: "browser", status: "skipped" }),
    ])
  })

  // Standard Protection, the default for new Vercel projects, covers every
  // generated URL, the production build's own included.
  function stageProtectedProduction(protectionBypass: Parameters<typeof api.addProject>[0]["protectionBypass"] = {}) {
    const remote = linkProject(undefined, {
      name: "shop",
      ssoProtection: { deploymentType: "prod_deployment_urls_and_all_previews" },
      protectionBypass,
    })
    api.addDeployment({ projectId: remote.id, uid: "dpl_old", target: "production", readySubstate: "PROMOTED" })
    remote.productionId = "dpl_old"
    const staged = api.addDeployment({
      projectId: remote.id,
      uid: "dpl_new",
      url: "shop-new.vercel.app",
      target: "production",
      readySubstate: "STAGED",
    })
    return { remote, staged }
  }

  const protectedSite = (seen: string[]) =>
    routed((url, sent) => {
      seen.push(url.host)
      return sent.get("x-vercel-protection-bypass") === "bypassfixture0000000000000000000000"
        ? new Response("ok")
        : new Response("", { status: 401, headers: { "set-cookie": "_vercel_sso_nonce=n" } })
    })

  test("leaves production alone when Deployment Protection keeps the checks out of a production build", async () => {
    const { remote, staged } = stageProtectedProduction()
    checks({ health: true, browser: true })
    const seen: string[] = []
    const result = await publishProject({ projectPath: project, target: "vercel", production: true }, undefined, {
      command: [await fakeDeployCli(`https://${staged.url}`)],
      sleep: async () => {},
      request: protectedSite(seen),
      browserCheck: async () => {
        throw new Error("a protected deployment is not rendered")
      },
    })
    expect(result.error).toContain("production was not moved")
    expect(result).toMatchObject({
      ok: false,
      errorCode: "checks_blocked",
      protectedChecks: "skipped",
      providerDeploymentId: "dpl_new",
    })
    expect(remote.productionId).toBe("dpl_old")
    expect(api.requests("POST").some((item) => item.path.includes("/promote/"))).toBe(false)
    expect(seen).toEqual(["shop-new.vercel.app"])
    expect(result.checks?.filter((check) => check.type === "health" || check.type === "browser")).toEqual([
      expect.objectContaining({ type: "health", status: "skipped", required: true }),
      expect.objectContaining({ type: "browser", status: "skipped", required: true }),
    ])
    expect(listDeployments(project)[0]).toMatchObject({ releaseStatus: "preview", providerDeploymentId: "dpl_new" })
  })

  test("with the bypass secret, checks the protected production build itself before promoting it", async () => {
    const { remote, staged } = stageProtectedProduction({
      bypassfixture0000000000000000000000: { createdAt: 1, createdBy: "user_1", scope: "automation-bypass" },
    })
    checks({ health: true, browser: true })
    const seen: string[] = []
    const browsed: string[] = []
    const result = await publishProject({ projectPath: project, target: "vercel", production: true }, undefined, {
      command: [await fakeDeployCli(`https://${staged.url}`)],
      sleep: async () => {},
      request: protectedSite(seen),
      browserCheck: async (url) => {
        browsed.push(`${url} promoted=${remote.productionId === "dpl_new"}`)
        return { ok: true, details: "Rendered.", output: "", durationMs: 1 }
      },
    })
    expect(result).toMatchObject({ ok: true, environment: "production", productionUrl: "https://shop.vercel.app" })
    expect(result.protectedChecks).toBeUndefined()
    expect(seen).toEqual(["shop-new.vercel.app"])
    expect(browsed).toEqual(["https://shop-new.vercel.app promoted=false"])
    expect(remote.productionId).toBe("dpl_new")
  })

  test("refuses to publish a site with no build step while its .env would be served", async () => {
    const remote = linkProject()
    api.addDeployment({ projectId: remote.id, uid: "dpl_first", target: "production" })
    remote.productionId = "dpl_first"
    const preview = api.addDeployment({ projectId: remote.id, uid: "dpl_p", url: "shop-p.vercel.app" })
    checks({ health: false, browser: false })
    await writeFile(join(project, ".env"), "API_URL=https://api.example\n")
    const options = { command: [await fakeDeployCli(`https://${preview.url}`)] }
    const blocked = await publishProject({ projectPath: project, target: "vercel" }, undefined, options)
    expect(blocked).toMatchObject({ ok: false, errorCode: "checks_failed" })
    expect(blocked.checks?.find((check) => check.type === "secrets")).toMatchObject({
      status: "failed",
      output: expect.stringContaining(".env:0 · public at /.env"),
    })
    expect(api.requests("GET").some((item) => item.path.includes("dpl_p"))).toBe(false)
    await writeFile(join(project, ".vercelignore"), "node_modules\n.env\n")
    expect(await publishProject({ projectPath: project, target: "vercel" }, undefined, options)).toMatchObject({
      ok: true,
    })
    // A site that builds serves its output, and its build may read .env.
    await writeFile(join(project, ".vercelignore"), "")
    await writeFile(join(project, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }))
    expect(await publishProject({ projectPath: project, target: "vercel" }, undefined, options)).toMatchObject({
      ok: true,
    })
  })

  test("an Observability check reports protection as protected and never touches the release checks", async () => {
    const remote = linkProject(undefined, { name: "shop", ssoProtection: { deploymentType: "preview" } })
    api.addDeployment({ projectId: remote.id, uid: "dpl_first", target: "production" })
    remote.productionId = "dpl_first"
    const preview = api.addDeployment({ projectId: remote.id, uid: "dpl_p", url: "shop-p.vercel.app" })
    checks({ health: true, browser: false })
    const protectedPreview = routed((_url, sent) =>
      sent.get("x-vercel-protection-bypass") === "bypassfixture0000000000000000000000"
        ? new Response("ok")
        : new Response("Authentication Required", { status: 401, headers: { "set-cookie": "_vercel_sso_nonce=n" } }),
    )
    const published = await publishProject({ projectPath: project, target: "vercel" }, undefined, {
      command: [await fakeDeployCli(`https://${preview.url}`)],
      request: protectedPreview,
    })
    expect(published).toMatchObject({ ok: true, protectedChecks: "skipped" })
    const id = published.deploymentId!
    const releaseChecks = listDeployments(project)[0].checks
    const checked = await checkDeploymentHealth({ projectPath: project, id }, { request: protectedPreview })
    expect(checked).toMatchObject({ probe: "protected", statusCode: 401 })
    expect(checked.status).not.toBe("degraded")
    remote.protectionBypass = {
      bypassfixture0000000000000000000000: { createdAt: 1, createdBy: "user_1", scope: "automation-bypass" },
    }
    const bypassed = await checkDeploymentHealth({ projectPath: project, id }, { request: protectedPreview })
    expect(bypassed).toMatchObject({ status: "ready", statusCode: 200, probe: "ok" })
    // A failing probe marks the release degraded, but the checks that gate
    // promotion and rollback stay as the release check left them.
    const broken = await checkDeploymentHealth(
      { projectPath: project, id },
      { request: routed(() => new Response("broken", { status: 500 })) },
    )
    expect(broken).toMatchObject({ status: "degraded", statusCode: 500, probe: "failed" })
    expect(broken.checks).toEqual(releaseChecks)
    const all = await checkAllDeploymentHealth(project, undefined, { request: protectedPreview })
    expect(all[0]).toMatchObject({ status: "ready", probe: "ok" })
    expect(all[0].checks).toEqual(releaseChecks)
  })

  test("uses the project's bypass secret to check a protected preview", async () => {
    const remote = linkProject(undefined, {
      name: "shop",
      ssoProtection: { deploymentType: "preview" },
      protectionBypass: {
        bypassfixture0000000000000000000000: { createdAt: 1, createdBy: "user_1", scope: "automation-bypass" },
      },
    })
    api.addDeployment({ projectId: remote.id, uid: "dpl_first", target: "production" })
    remote.productionId = "dpl_first"
    const preview = api.addDeployment({ projectId: remote.id, uid: "dpl_p", url: "shop-p.vercel.app" })
    checks({ health: true, browser: true })
    const headers: Record<string, string>[] = []
    const result = await publishProject({ projectPath: project, target: "vercel" }, undefined, {
      command: [await fakeDeployCli(`https://${preview.url}`)],
      request: routed((_url, sent) =>
        sent.get("x-vercel-protection-bypass") === "bypassfixture0000000000000000000000"
          ? new Response("ok")
          : new Response("", { status: 401, headers: { "set-cookie": "_vercel_sso_nonce=n" } }),
      ),
      browserCheck: async (_url, _id, sent) => {
        headers.push(sent)
        return { ok: true, details: "Rendered.", output: "", durationMs: 1 }
      },
    })
    expect(result).toMatchObject({ ok: true, protectedChecks: undefined })
    expect(headers).toEqual([
      { "x-vercel-protection-bypass": "bypassfixture0000000000000000000000", "x-vercel-set-bypass-cookie": "true" },
    ])
  })

  test("names the cause when the token is rejected, nothing is linked, or Vercel's build fails", async () => {
    checks({ health: false, browser: false })
    const cli = await fakeDeployCli("https://shop-x.vercel.app")
    expect(
      await publishProject({ projectPath: project, target: "vercel" }, undefined, { command: [cli] }),
    ).toMatchObject({
      ok: false,
      errorCode: "not_linked",
    })
    const remote = linkProject()
    api.state.rejectToken = true
    const rejected = await publishProject({ projectPath: project, target: "vercel" }, undefined, { command: [cli] })
    expect(rejected).toMatchObject({ ok: false, errorCode: "token_rejected" })
    expect(rejected.error).toContain("Reconnect Vercel")
    expect(listDeployments(project)).toEqual([])
    api.state.rejectToken = false
    api.addDeployment({
      projectId: remote.id,
      url: "shop-x.vercel.app",
      readyState: "ERROR",
      errorMessage: 'Command "npm run build" exited with 1',
      events: [{ type: "stderr", created: 1, payload: { text: "src/app.ts(3,1): error TS2304" } }],
    })
    const failed = await publishProject({ projectPath: project, target: "vercel" }, undefined, { command: [cli] })
    expect(failed).toMatchObject({ ok: false, errorCode: "build_failed" })
    expect(failed.error).toContain("exited with 1")
    expect(failed.log).toContain("error TS2304")
  })

  test("an agent workspace preview gets its branch's stable address", async () => {
    const remote = linkProject("team_1")
    api.addDeployment({ projectId: remote.id, uid: "dpl_first", target: "production" })
    remote.productionId = "dpl_first"
    const preview = api.addDeployment({ projectId: remote.id, uid: "dpl_ws", url: "shop-ws.vercel.app" })
    checks({ health: false, browser: false })
    await Bun.$`git init -q -b agent/fix-cart && git -c user.email=a@b.invalid -c user.name=A commit -q --allow-empty -m init`
      .cwd(project)
      .quiet()
    const result = await publishProject(
      { projectPath: project, target: "vercel", workspaceId: "ws-unknown", workspaceName: "Agent 1" },
      undefined,
      { command: [await fakeDeployCli(`https://${preview.url}`)] },
    )
    expect(result).toMatchObject({
      ok: true,
      alias: "https://shop-git-agent-fix-cart-acme.vercel.app",
      url: "https://shop-git-agent-fix-cart-acme.vercel.app",
    })
    expect(preview.alias).toEqual(["shop-git-agent-fix-cart-acme.vercel.app"])
    expect(listDeployments(project)[0]).toMatchObject({
      workspaceId: "ws-unknown",
      alias: "https://shop-git-agent-fix-cart-acme.vercel.app/",
    })
  })

  test("refuses a Vercel CLI login alone: publishing needs the account connected in Vector Cloud", async () => {
    checks({ health: false, browser: false })
    linkProject()
    stores.delete("cloud-provider-connections")
    const result = await publishProject({ projectPath: project, target: "vercel" }, undefined, {
      command: [await fakeDeployCli("https://shop-x.vercel.app")],
    })
    expect(result).toMatchObject({ ok: false, errorCode: "not_connected", log: "" })
    expect(result.error).toContain("Vercel is not connected")
    expect(listDeployments(project)).toEqual([])
  })

  test("returns a failed build's evidence with the project's secrets redacted", async () => {
    linkProject()
    setEnv(project, undefined, "PAYMENTS_SECRET", "fixture-payments-value-123", "server")
    setBuildSettings(project, undefined, {
      framework: "Static",
      packageManager: "static",
      installCommand: "",
      testCommand: "",
      buildCommand: 'echo "connecting with fixture-payments-value-123" && exit 3',
      outputDirectory: ".",
      nodeVersion: "",
      healthPath: "/",
      requiredChecks: { test: false, secrets: true, health: false, browser: false },
    })
    const result = await publishProject({ projectPath: project, target: "vercel" }, undefined, {
      command: ["never-run"],
    })
    expect(result).toMatchObject({ ok: false, errorCode: "checks_failed" })
    const build = result.checks?.find((check) => check.id === "build")
    expect(build).toMatchObject({ status: "failed", required: true, details: "Production build failed." })
    expect(build?.output).toContain("connecting with [redacted]")
    expect(JSON.stringify(result)).not.toContain("fixture-payments-value-123")
    expect(listDeployments(project)).toEqual([])
  })
})
