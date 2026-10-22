import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import path from "path"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Npm } from "@vectordevai/core/npm"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Global } from "@vectordevai/core/global"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { TuiEvent } from "@/server/tui-event"
import { Auth } from "../../src/auth"
import { Env } from "../../src/env"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// Vector Local's policy as the engine resolves it: once, from the user's own config and the company's policy, with
// the environment and the config overrides only tightening it, and a loosening edit held until the owner confirms.

const guard = NetworkGuard.use()

const globalFile = path.join(Global.Path.config, "vector.json")
const managedDirectory = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!
const engineDirectory = path.resolve(import.meta.dir, "../..")
const ENVIRONMENT = ["VECTOR_LOCAL", "VECTOR_LOCAL_WEB", "VECTOR_LOCAL_POLICY", "VECTOR_CONFIG_CONTENT"] as const
const saved = Object.fromEntries(ENVIRONMENT.map((key) => [key, process.env[key]]))

const SERVER = "http://127.0.0.1:11434"
const GPU_BOX = "http://10.0.0.5:8000"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Npm.node, NpmTest.noop],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.die(`unexpected http request: ${request.url}`)),
      ),
    ],
  ]),
)

afterEach(() => {
  ENVIRONMENT.forEach((key) => {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  })
  rmSync(globalFile, { force: true })
  rmSync(Config.localConfirmedFile(), { force: true })
  rmSync(managedDirectory, { recursive: true, force: true })
  Config.refreshLocal()
  expect(guard.outside()).toEqual([])
})

function writeGlobal(local: object | undefined) {
  writeFileSync(globalFile, JSON.stringify({ $schema: "https://vectordev.ai/config.json", local }))
}

function writeManaged(config: object) {
  mkdirSync(managedDirectory, { recursive: true })
  writeFileSync(path.join(managedDirectory, "vector.json"), JSON.stringify(config))
}

function nextChange(type: Config.LocalChange["type"]) {
  const { promise, resolve, reject } = Promise.withResolvers<Config.LocalChange>()
  const timer = setTimeout(() => reject(new Error(`no ${type} change within 5 seconds`)), 5_000)
  const unsubscribe = Config.subscribeLocal((change) => {
    if (change.type !== type) return
    clearTimeout(timer)
    unsubscribe()
    resolve(change)
  })
  return promise
}

async function run(script: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: engineDirectory,
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`the child exited with ${code}: ${stderr}`)
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "")
}

describe("resolved at start", () => {
  test("the policy is resolved before the first catalog fetch", async () => {
    await using dir = await tmpdir()
    const managed = path.join(dir.path, "managed")
    mkdirSync(managed)
    writeFileSync(path.join(managed, "vector.json"), JSON.stringify({ local: { enabled: true, web: "none" } }))
    const requests: string[] = []
    using mirror = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(new URL(request.url).pathname)
        return Response.json({})
      },
    })
    const url = (file: string) => JSON.stringify(new URL(file, import.meta.url).href)
    // The engine's runtime is imported and nothing has run yet: no layer is built and the catalog has not been asked
    // for. The floor children get is set when the policy is resolved, so it shows the policy was already in effect.
    const result = await run(
      `
      const { untrustedChildEnvironment } = await import(${url("../../../core/src/child-environment.ts")})
      const { AppRuntime } = await import(${url("../../src/effect/app-runtime.ts")})
      const floor = untrustedChildEnvironment({})
      const { ModelCatalog } = await import(${url("../../../core/src/model-catalog.ts")})
      await AppRuntime.runPromise(ModelCatalog.Service.use((catalog) => catalog.get()))
      process.stdout.write(JSON.stringify({ floor }) + "\\n")
      await AppRuntime.dispose()
      process.exit(0)
      `,
      {
        ...process.env,
        XDG_CONFIG_HOME: path.join(dir.path, "config"),
        XDG_STATE_HOME: path.join(dir.path, "state"),
        XDG_DATA_HOME: path.join(dir.path, "data"),
        XDG_CACHE_HOME: path.join(dir.path, "cache"),
        VECTOR_TEST_MANAGED_CONFIG_DIR: managed,
        VECTOR_MODELS_URL: `http://127.0.0.1:${mirror.port}/models`,
        VECTOR_MODELS_PATH: undefined,
        VECTOR_DISABLE_MODELS_FETCH: undefined,
      },
    )
    expect(result.floor).toEqual({ VECTOR_AGENT_SESSION: "1", VECTOR_LOCAL: "1", VECTOR_LOCAL_WEB: "none" })
    expect(requests).toContain("/models/api.json")
  }, 30_000)

  test("resolving it is synchronous and waits on no other service", () => {
    writeManaged({ local: { enabled: true, endpoints: [SERVER] } })
    const policy = Config.refreshLocal()
    expect(policy).toMatchObject({ enabled: true, web: "ask", endpoints: [{ origin: SERVER, from: "managed" }] })
    expect(policy.pending).toBe(undefined)
    expect(Config.local()).toBe(policy)
  })
})

describe("repository config", () => {
  const repository = { local: { enabled: false, web: "ask" as const, endpoints: [GPU_BOX] } }

  for (const trusted of [true, false])
    it.instance(
      `a ${trusted ? "trusted" : "untrusted"} repository's local block is dropped`,
      Effect.gen(function* () {
        writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
        Config.refreshLocal()
        const config = yield* Config.use.get()
        expect(config.local).toEqual({ enabled: true, web: "network", endpoints: [SERVER] })
        expect(Config.local()).toMatchObject({
          enabled: true,
          web: "network",
          endpoints: [{ origin: SERVER, from: "user" }],
        })
      }),
      {
        trusted,
        config: repository,
        init: (directory) =>
          Effect.sync(() => {
            mkdirSync(path.join(directory, ".vector"))
            writeFileSync(path.join(directory, ".vector", "vector.json"), JSON.stringify(repository))
          }),
      },
    )

  it.instance(
    "a repository cannot turn Vector Local on either",
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(config.local).toBe(undefined)
      expect(Config.local().enabled).toBe(false)
    }),
    { trusted: true, config: { local: { enabled: true, web: "none" } } },
  )
})

describe("the environment only tightens", () => {
  test("VECTOR_LOCAL and VECTOR_LOCAL_WEB add a floor", () => {
    writeGlobal({ enabled: false, web: "ask", endpoints: [SERVER] })
    expect(Config.refreshLocal().enabled).toBe(false)
    process.env.VECTOR_LOCAL = "1"
    process.env.VECTOR_LOCAL_WEB = "network"
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "network" })
  })

  test("they cannot loosen what the user's config sets", () => {
    writeGlobal({ enabled: true, web: "none", endpoints: [SERVER] })
    process.env.VECTOR_LOCAL = "0"
    process.env.VECTOR_LOCAL_WEB = "ask"
    const policy = Config.refreshLocal()
    expect(policy).toMatchObject({ enabled: true, web: "none" })
    expect(policy.warnings).toContain("Ignored VECTOR_LOCAL_WEB=ask: it can only be none or network.")
  })

  test("VECTOR_LOCAL_POLICY can add a server but cannot lock or allow a service", () => {
    writeGlobal({ enabled: true, endpoints: [SERVER] })
    process.env.VECTOR_LOCAL_POLICY = JSON.stringify({
      enabled: true,
      web: "ask",
      endpoints: [GPU_BOX],
      lock: true,
      allow: [{ source: "github", reason: "PRs", added_at: 1, added_by: "cli" }],
    })
    const policy = Config.refreshLocal()
    expect(policy.lock).toBe(false)
    expect(policy.allow).toEqual([])
    expect(policy.endpoints).toEqual([
      { origin: SERVER, from: "user" },
      { origin: GPU_BOX, from: "environment" },
    ])
  })
})

describe("config overrides only tighten", () => {
  test("VECTOR_CONFIG_CONTENT cannot loosen Vector Local", () => {
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER], web_domains: { deny: ["tracker.example"] } })
    process.env.VECTOR_CONFIG_CONTENT = JSON.stringify({
      local: {
        enabled: false,
        web: "ask",
        endpoints: [GPU_BOX],
        allow: [{ source: "github", reason: "PRs", added_at: 1, added_by: "cli" }],
        web_domains: { allow: ["docs.example.com"], deny: ["ads.example"] },
        lock: false,
      },
    })
    const policy = Config.refreshLocal()
    expect(policy).toMatchObject({
      enabled: true,
      web: "network",
      endpoints: [{ origin: SERVER, from: "user" }],
      allow: [],
      web_domains: { allow: [], deny: ["tracker.example", "ads.example"] },
    })
    expect(policy.warnings).toContain(
      "Ignored enabled, web, endpoints, allow, web_domains.allow, lock in the local block of VECTOR_CONFIG_CONTENT: it can only make Vector Local stricter.",
    )
  })

  test("VECTOR_CONFIG_CONTENT can tighten Vector Local", () => {
    writeGlobal({ endpoints: [SERVER] })
    process.env.VECTOR_CONFIG_CONTENT = JSON.stringify({ local: { enabled: true, web: "none" } })
    expect(Config.refreshLocal()).toMatchObject({
      enabled: true,
      web: "none",
      endpoints: [{ origin: SERVER, from: "user" }],
      warnings: [],
    })
  })

  it.instance(
    "the merged config never carries VECTOR_CONFIG_CONTENT's local block",
    Effect.gen(function* () {
      writeGlobal({ enabled: true, endpoints: [SERVER] })
      process.env.VECTOR_CONFIG_CONTENT = JSON.stringify({ model: "content/model", local: { enabled: false } })
      Config.refreshLocal()
      const config = yield* Config.use.get()
      expect(config.model).toBe("content/model")
      expect(config.local).toEqual({ enabled: true, endpoints: [SERVER] })
      expect(Config.local().enabled).toBe(true)
    }),
  )

  test("a local block Vector cannot read keeps Vector Local on with Web access None", () => {
    writeGlobal({ enabled: false, web: "sometimes" })
    const policy = Config.refreshLocal()
    expect(policy).toMatchObject({ enabled: true, web: "none" })
    expect(policy.warnings).toEqual([
      `Vector could not read the local block in ${globalFile}, so Vector Local stays on with Web access None until it is fixed.`,
    ])
    // Fixing it needs no confirmation: the unreadable block never counted as one the owner let apply.
    writeGlobal({ enabled: false })
    expect(Config.refreshLocal().enabled).toBe(false)
    expect(Config.localPending()).toBe(undefined)
  })
})

describe("children inherit the Local floor", () => {
  test("untrusted children get VECTOR_LOCAL, a Web access at least as strict and the agent marker", () => {
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
    Config.refreshLocal()
    expect(
      untrustedChildEnvironment({
        PATH: "/usr/bin",
        VECTOR_LOCAL: "0",
        VECTOR_LOCAL_WEB: "ask",
        vector_local_web: "ask",
      }),
    ).toEqual({ PATH: "/usr/bin", VECTOR_LOCAL: "1", VECTOR_LOCAL_WEB: "network", VECTOR_AGENT_SESSION: "1" })
    // A stricter setting a child already has is kept, as is the session a marker names.
    expect(untrustedChildEnvironment({ VECTOR_LOCAL_WEB: "none", VECTOR_AGENT_SESSION: "ses_parent" })).toEqual({
      VECTOR_LOCAL: "1",
      VECTOR_LOCAL_WEB: "none",
      VECTOR_AGENT_SESSION: "ses_parent",
    })
  })

  test("with Vector Local off, children get only the agent marker", () => {
    writeGlobal({ enabled: false })
    Config.refreshLocal()
    expect(untrustedChildEnvironment({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin", VECTOR_AGENT_SESSION: "1" })
  })

  test("a nested vector keeps Local on whatever config it reads", async () => {
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
    Config.refreshLocal()
    await using dir = await tmpdir()
    // The nested process reads another config folder, which turns Vector Local off.
    mkdirSync(path.join(dir.path, "config", "vector"), { recursive: true })
    writeFileSync(path.join(dir.path, "config", "vector", "vector.json"), JSON.stringify({ local: { enabled: false } }))
    const environment = untrustedChildEnvironment(process.env, {
      XDG_CONFIG_HOME: path.join(dir.path, "config"),
      XDG_STATE_HOME: path.join(dir.path, "state"),
    })
    const policy = await run(
      `
      const { Config } = await import(${JSON.stringify(new URL("../../src/config/config.ts", import.meta.url).href)})
      process.stdout.write(JSON.stringify(Config.local()) + "\\n")
      process.exit(0)
      `,
      environment,
    )
    expect(policy).toMatchObject({ enabled: true, web: "network" })
  }, 30_000)
})

describe("loosening edits wait for the owner", () => {
  test("a loosening edit to global config produces a confirmation event and does not apply until confirmed", async () => {
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
    expect(Config.refreshLocal().enabled).toBe(true)
    const toasts: GlobalEvent[] = []
    const onEvent = (event: GlobalEvent) => {
      if (event.payload?.type === TuiEvent.ToastShow.type) toasts.push(event)
    }
    GlobalBus.on("event", onEvent)
    const stop = Config.watchLocal()
    try {
      const asked = nextChange("loosening")
      writeGlobal({ enabled: false, endpoints: [SERVER, GPU_BOX] })
      const change = await asked
      expect(change).toMatchObject({ type: "loosening", changes: ["turns Vector Local off"] })
      // Nothing loosened: the policy in effect and what children inherit stay as they were.
      expect(Config.local()).toMatchObject({ enabled: true, web: "network", endpoints: [{ origin: SERVER }] })
      expect(untrustedChildEnvironment({}).VECTOR_LOCAL).toBe("1")
      expect(Config.localPending()?.proposed.enabled).toBe(false)
      expect(toasts.map((event) => event.payload.properties.message)).toEqual([
        "A change to your config would loosen Vector Local: it turns Vector Local off. Vector keeps the stricter setting until you confirm the change.",
      ])

      const applied = nextChange("updated")
      Config.confirmLocal()
      expect((await applied).type).toBe("updated")
      expect(Config.local().enabled).toBe(false)
      expect(Config.localPending()).toBe(undefined)
      expect(untrustedChildEnvironment({})).toEqual({ VECTOR_AGENT_SESSION: "1" })
    } finally {
      stop()
      GlobalBus.off("event", onEvent)
    }
  })

  test("a tightening edit applies at once", async () => {
    writeGlobal({ enabled: true, web: "ask", endpoints: [SERVER, GPU_BOX] })
    Config.refreshLocal()
    const stop = Config.watchLocal()
    try {
      const applied = nextChange("updated")
      writeGlobal({ enabled: true, web: "none", endpoints: [SERVER] })
      expect((await applied).type).toBe("updated")
      expect(Config.local()).toMatchObject({ web: "none", endpoints: [{ origin: SERVER }] })
      expect(Config.localPending()).toBe(undefined)
    } finally {
      stop()
    }
  })

  it.instance(
    "the config service watches while it is up",
    Effect.gen(function* () {
      writeGlobal({ enabled: true, web: "ask", endpoints: [SERVER] })
      Config.refreshLocal()
      yield* Config.use.get()
      const asked = nextChange("loosening")
      writeGlobal({ enabled: true, web: "ask", endpoints: [SERVER, GPU_BOX] })
      const change = yield* Effect.promise(() => asked)
      expect(change).toMatchObject({ changes: [`adds the model server ${GPU_BOX}`] })
      expect(Config.local().endpoints).toEqual([{ origin: SERVER, from: "user" }])
    }),
  )

  test("an edit made while Vector is closed is held at the next start", () => {
    writeGlobal({ enabled: true, web: "none", endpoints: [SERVER] })
    Config.refreshLocal()
    expect(JSON.parse(readFileSync(Config.localConfirmedFile(), "utf8"))).toEqual({
      local: { enabled: true, web: "none", endpoints: [SERVER] },
    })
    writeGlobal({
      enabled: true,
      web: "ask",
      endpoints: [SERVER, GPU_BOX],
      allow: [{ source: "github", reason: "PRs", added_at: 1, added_by: "cli" }],
      web_domains: { allow: ["docs.example.com"] },
    })
    // What a fresh process does when it loads.
    const policy = Config.refreshLocal()
    expect(policy).toMatchObject({ enabled: true, web: "none", endpoints: [{ origin: SERVER }], allow: [] })
    expect(Config.localPending()?.changes).toEqual([
      "sets Web access to Ask",
      `adds the model server ${GPU_BOX}`,
      "allows github",
      "lets web pages reach docs.example.com",
    ])
  })

  test("deleting the user's config is held too", () => {
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
    Config.refreshLocal()
    rmSync(globalFile)
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "network" })
    expect(Config.localPending()?.changes).toEqual(["turns Vector Local off"])
  })

  test("a company change applies without asking", () => {
    writeManaged({ local: { enabled: true, web: "none" } })
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "none" })
    rmSync(managedDirectory, { recursive: true })
    expect(Config.refreshLocal().enabled).toBe(false)
    expect(Config.localPending()).toBe(undefined)
  })

  test.skipIf(process.platform === "win32")("the confirmed block is readable by the user only", () => {
    writeGlobal({ enabled: true, endpoints: [SERVER] })
    Config.refreshLocal()
    expect(statSync(Config.localConfirmedFile()).mode & 0o777).toBe(0o600)
  })
})

describe("what counts as loosening", () => {
  const on = LocalPolicy.resolve({ global: { enabled: true, web: "network", endpoints: [SERVER] } })

  test("turning Local on, a stricter Web access, fewer servers or more denied sites only tighten", () => {
    const off = LocalPolicy.resolve({})
    expect(Config.loosening(off, on)).toEqual([])
    expect(Config.loosening(on, LocalPolicy.resolve({ global: { enabled: true, web: "none" } }))).toEqual([])
    expect(
      Config.loosening(
        on,
        LocalPolicy.resolve({
          global: { enabled: true, web: "network", endpoints: [SERVER], web_domains: { deny: ["ads.example"] } },
        }),
      ),
    ).toEqual([])
  })

  test("a site no longer denied loosens", () => {
    const denying = LocalPolicy.resolve({ global: { enabled: true, web_domains: { deny: ["ads.example"] } } })
    expect(Config.loosening(denying, LocalPolicy.resolve({ global: { enabled: true } }))).toEqual([
      "stops blocking ads.example",
    ])
  })
})
