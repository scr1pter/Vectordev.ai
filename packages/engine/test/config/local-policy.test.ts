import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
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
import { Egress } from "@vectordevai/core/local-mode/egress"
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
const ENVIRONMENT = [
  "VECTOR_LOCAL",
  "VECTOR_LOCAL_WEB",
  "VECTOR_LOCAL_POLICY",
  "VECTOR_CONFIG_CONTENT",
  "VECTOR_AGENT_CONFIG",
  "VECTOR_AGENT_CONFIG_DIR",
  "VECTOR_CLIENT",
] as const
const saved = Object.fromEntries(ENVIRONMENT.map((key) => [key, process.env[key]]))

const SERVER = "http://127.0.0.1:11434"
const GPU_BOX = "http://10.0.0.5:8000"
const GITHUB = { source: "github", reason: "PRs", added_at: 1, added_by: "cli" as const }
const CATALOG = { source: "catalog", reason: "Models", added_at: 1, added_by: "app" as const }
const CONFIG = JSON.stringify(new URL("../../src/config/config.ts", import.meta.url).href)

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
  // Removing a test's config can loosen Vector Local, which waits for the owner; the owner here says yes.
  Config.refreshLocal()
  Config.confirmLocal()
  expect(Config.localPending()).toBe(undefined)
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
  const change = Promise.withResolvers<Config.LocalChange>()
  const timer = setTimeout(() => change.reject(new Error(`no ${type} change within 5 seconds`)), 5_000)
  const unsubscribe = Config.subscribeLocal((next) => {
    if (next.type !== type) return
    clearTimeout(timer)
    unsubscribe()
    change.resolve(next)
  })
  return change.promise
}

async function run(script: string, env: Record<string, string | undefined>, cwd = engineDirectory) {
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd,
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

// What a fresh process resolves at start, with this environment.
function start(env: Record<string, string | undefined>, cwd?: string) {
  return run(
    `
    const { Config } = await import(${CONFIG})
    process.stdout.write(JSON.stringify({ policy: Config.local(), pending: Config.localPending()?.changes ?? null }) + "\\n")
    process.exit(0)
    `,
    env,
    cwd,
  )
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
      const { ConfigManaged } = await import(${url("../../src/config/managed.ts")})
      ConfigManaged.useTestDirectory(${JSON.stringify(managed)})
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
        // Config.local() is the only reader: the merged config carries no local block at all.
        expect(config.local).toBe(undefined)
        expect(Config.local()).toMatchObject({
          enabled: true,
          web: "network",
          endpoints: [{ origin: SERVER, from: "user" }],
        })
        // The policy this repository reports says its own block was left out.
        const policy = yield* Config.use.localPolicy()
        expect(policy.warnings).toContain(LocalPolicy.REPOSITORY_IGNORED)
        expect(policy).toMatchObject({ enabled: true, web: "network", endpoints: [{ origin: SERVER }] })
        expect(Config.local().warnings).not.toContain(LocalPolicy.REPOSITORY_IGNORED)
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

  it.instance(
    "a repository without a local block reports no warning",
    Effect.gen(function* () {
      expect((yield* Config.use.localPolicy()).warnings).toEqual([])
    }),
    { trusted: true, config: { model: "repository/model" } },
  )
})

describe("the egress guard", () => {
  test("decides under the policy config resolves, from the moment it is resolved", () => {
    writeGlobal({ enabled: true, endpoints: [GPU_BOX] })
    const policy = Config.refreshLocal()
    expect(Egress.policy()).toBe(policy)
    expect(Egress.decide({ source: "local-inference", url: `${GPU_BOX}/v1` }).rule).toBe("listed")
    rmSync(globalFile, { force: true })
    Config.refreshLocal()
    Config.confirmLocal()
    expect(Egress.policy().enabled).toBe(false)
  })
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
    Config.refreshLocal()
    process.env.VECTOR_LOCAL_POLICY = JSON.stringify({
      enabled: true,
      web: "ask",
      endpoints: [GPU_BOX],
      lock: true,
      allow: [GITHUB],
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
        allow: [GITHUB],
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
    Config.refreshLocal()
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
      expect(config.local).toBe(undefined)
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

  test("a nested vector keeps Local on whatever XDG_CONFIG_HOME it reads, and holds what that config adds", async () => {
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
    Config.refreshLocal()
    await using dir = await tmpdir()
    // The nested process reads another config folder, which turns Vector Local off and adds to it, with a state
    // folder of its own, so no copy of a block the owner let apply.
    mkdirSync(path.join(dir.path, "config", "vector"), { recursive: true })
    writeFileSync(
      path.join(dir.path, "config", "vector", "vector.json"),
      JSON.stringify({ local: { enabled: false, web: "ask", endpoints: [GPU_BOX], allow: [GITHUB] } }),
    )
    const next = await start(
      untrustedChildEnvironment(process.env, {
        XDG_CONFIG_HOME: path.join(dir.path, "config"),
        XDG_STATE_HOME: path.join(dir.path, "state"),
      }),
    )
    expect(next.policy).toMatchObject({ enabled: true, web: "network", endpoints: [], allow: [] })
    expect(next.pending).toEqual([`adds the model server ${GPU_BOX}`, "allows github"])
  }, 30_000)
})

describe("config-path overrides", () => {
  test("VECTOR_AGENT_CONFIG only tightens", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "agent.json")
    writeFileSync(
      file,
      JSON.stringify({ local: { enabled: false, web: "none", endpoints: [GPU_BOX], allow: [GITHUB] } }),
    )
    writeGlobal({ enabled: true, web: "ask", endpoints: [SERVER] })
    Config.refreshLocal()
    // Vector reads VECTOR_AGENT_CONFIG once, when it starts.
    const next = await start({ ...process.env, VECTOR_AGENT_CONFIG: file })
    expect(next.policy).toMatchObject({
      enabled: true,
      web: "none",
      endpoints: [{ origin: SERVER, from: "user" }],
      allow: [],
    })
    expect(next.policy.warnings).toContain(
      `Ignored enabled, endpoints, allow in the local block of ${file}: it can only make Vector Local stricter.`,
    )
    expect(next.pending).toBe(null)
  }, 30_000)

  test("a VECTOR_AGENT_CONFIG_DIR that is not the desktop's own config folder only tightens", async () => {
    await using dir = await tmpdir()
    const folder = path.join(dir.path, "agent")
    mkdirSync(folder)
    writeFileSync(
      path.join(folder, "vector.json"),
      JSON.stringify({ local: { enabled: false, web: "ask", allow: [CATALOG] } }),
    )
    writeGlobal({ enabled: true, web: "none" })
    process.env.VECTOR_AGENT_CONFIG_DIR = folder
    const policy = Config.refreshLocal()
    expect(policy).toMatchObject({ enabled: true, web: "none", allow: [] })
    expect(policy.warnings).toContain(
      `Ignored enabled, web, allow in the local block of ${path.join(folder, "vector.json")}: it can only make Vector Local stricter.`,
    )
    expect(Config.localPending()).toBe(undefined)
  })

  test("the desktop's own config folder sets Vector Local, and what it adds later is held", async () => {
    await using dir = await tmpdir()
    const folder = path.join(dir.path, "userData", "config", "vector")
    mkdirSync(folder, { recursive: true })
    const file = path.join(folder, "vector.json")
    writeFileSync(file, JSON.stringify({ local: { enabled: true, endpoints: [SERVER] } }))
    process.env.VECTOR_CLIENT = "desktop"
    process.env.VECTOR_AGENT_CONFIG_DIR = folder
    try {
      expect(Config.refreshLocal()).toMatchObject({ enabled: true, endpoints: [{ origin: SERVER, from: "user" }] })
      writeFileSync(file, JSON.stringify({ local: { enabled: true, endpoints: [SERVER, GPU_BOX] } }))
      expect(Config.refreshLocal().endpoints).toEqual([{ origin: SERVER, from: "user" }])
      expect(Config.localPending()?.changes).toEqual([`adds the model server ${GPU_BOX}`])
    } finally {
      rmSync(file)
      Config.refreshLocal()
      Config.confirmLocal()
      rmSync(Config.localConfirmedFile(), { force: true })
    }
  })

  test("a config folder inside the repository Vector started in is not read", async () => {
    await using dir = await tmpdir()
    const repository = path.join(dir.path, "repository")
    const folder = path.join(repository, "agentcfg")
    mkdirSync(path.join(repository, ".git"), { recursive: true })
    mkdirSync(folder)
    writeFileSync(path.join(folder, "vector.json"), JSON.stringify({ local: { enabled: true, allow: [CATALOG] } }))
    writeGlobal({ enabled: false })
    // A repository's .envrc can name its own folder, and say the desktop started Vector.
    process.env.VECTOR_CLIENT = "desktop"
    process.env.VECTOR_AGENT_CONFIG_DIR = folder
    const previous = process.cwd()
    process.chdir(path.join(repository, ".git"))
    try {
      const policy = Config.refreshLocal()
      // Not even to tighten: a repository cannot turn Vector Local on either.
      expect(policy).toMatchObject({ enabled: false, allow: [] })
      expect(policy.warnings).toEqual([
        `Ignored ${folder}: it is inside the repository Vector started in, and only your user config and your company's policy set Vector Local.`,
      ])
    } finally {
      process.chdir(previous)
    }
  })

  test("a VECTOR_AGENT_CONFIG inside the repository Vector started in is not read", async () => {
    await using dir = await tmpdir()
    const repository = path.join(dir.path, "repository")
    mkdirSync(path.join(repository, ".git"), { recursive: true })
    const file = path.join(repository, "agent.json")
    writeFileSync(file, JSON.stringify({ local: { enabled: true, web: "none" } }))
    writeGlobal({ enabled: false })
    const next = await start({ ...process.env, VECTOR_AGENT_CONFIG: file }, repository)
    expect(next.policy).toMatchObject({ enabled: false, web: "ask" })
    expect(next.policy.warnings).toEqual([
      `Ignored ${file}: it is inside the repository Vector started in, and only your user config and your company's policy set Vector Local.`,
    ])
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
        "A change to your config would loosen Vector Local: it turns Vector Local off. Vector keeps the stricter setting. Confirming a change like this in the app or a terminal comes in the next release.",
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

  test("an edit made while Vector is closed is held at the next start", async () => {
    writeGlobal({ enabled: true, web: "none", endpoints: [SERVER] })
    Config.refreshLocal()
    expect(JSON.parse(readFileSync(Config.localConfirmedFile(), "utf8"))).toEqual({
      local: { enabled: true, web: "none", endpoints: [SERVER] },
    })
    writeGlobal({
      enabled: true,
      web: "ask",
      endpoints: [SERVER, GPU_BOX],
      allow: [GITHUB],
      web_domains: { allow: ["docs.example.com"] },
    })
    const next = await start(process.env)
    expect(next.policy).toMatchObject({ enabled: true, web: "none", endpoints: [{ origin: SERVER }], allow: [] })
    expect(next.pending).toEqual([
      "sets Web access to Ask",
      `adds the model server ${GPU_BOX}`,
      "allows github",
      "lets web pages reach docs.example.com",
    ])
  }, 30_000)

  test("at start, a missing or unreadable copy counts as no user block, which still holds what it adds", async () => {
    writeGlobal({ endpoints: [GPU_BOX], allow: [CATALOG] })
    for (const copy of [undefined, "garbage", JSON.stringify({ local: { enabled: "yes" } })]) {
      rmSync(Config.localConfirmedFile(), { force: true })
      if (copy) writeFileSync(Config.localConfirmedFile(), copy)
      const next = await start({ ...process.env, VECTOR_LOCAL: "1" })
      expect(next.policy).toMatchObject({ enabled: true, endpoints: [], allow: [] })
      expect(next.pending).toEqual([`adds the model server ${GPU_BOX}`, "allows catalog"])
    }
  }, 60_000)

  test("deleting or corrupting the saved copy while Vector runs changes nothing", () => {
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
    Config.refreshLocal()
    rmSync(Config.localConfirmedFile())
    writeGlobal({ enabled: false })
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "network" })
    expect(Config.localPending()?.changes).toEqual(["turns Vector Local off"])
    writeFileSync(Config.localConfirmedFile(), "garbage")
    writeGlobal({ enabled: true, web: "ask", endpoints: [SERVER], allow: [GITHUB] })
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "network", allow: [] })
    expect(Config.localPending()?.changes).toEqual(["sets Web access to Ask", "allows github"])
  })

  for (const via of ["VECTOR_LOCAL", "company policy"] as const)
    test(`with Vector Local on through ${via} and no local block of the user's, what the user adds is held`, () => {
      if (via === "VECTOR_LOCAL") {
        process.env.VECTOR_LOCAL = "1"
        process.env.VECTOR_LOCAL_WEB = "network"
      }
      if (via === "company policy") writeManaged({ local: { enabled: true, web: "network" } })
      writeGlobal({ enabled: true })
      Config.refreshLocal()
      // Dropping a block that changed nothing applies, and the saved copy records that the user has none.
      writeGlobal(undefined)
      expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "network" })
      expect(JSON.parse(readFileSync(Config.localConfirmedFile(), "utf8"))).toEqual({ local: null })
      writeGlobal({ allow: [CATALOG], endpoints: [GPU_BOX], web_domains: { allow: ["*.example.com"] } })
      expect(Config.refreshLocal()).toMatchObject({
        enabled: true,
        web: "network",
        endpoints: [],
        allow: [],
        web_domains: { allow: [] },
      })
      expect(Config.localPending()?.changes).toEqual([
        `adds the model server ${GPU_BOX}`,
        "allows catalog",
        "lets web pages reach *.example.com",
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

// Root reads any file, and Windows has no mode bits to take away.
const unreadable = process.platform === "win32" || process.getuid?.() === 0 ? test.skip : test

describe("sources Vector cannot read", () => {
  unreadable("a user config Vector cannot read keeps the last block in effect, with no web while Local is on", () => {
    writeGlobal({ enabled: true, web: "ask", endpoints: [SERVER] })
    Config.refreshLocal()
    chmodSync(globalFile, 0o000)
    try {
      const policy = Config.refreshLocal()
      expect(policy).toMatchObject({ enabled: true, web: "none", endpoints: [{ origin: SERVER }] })
      expect(policy.warnings).toEqual([
        `Vector could not read ${globalFile}.`,
        `Vector Local stays on with Web access None until Vector can read ${globalFile}.`,
      ])
      expect(Config.localPending()).toBe(undefined)
    } finally {
      chmodSync(globalFile, 0o644)
    }
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "ask", warnings: [] })
  })

  unreadable("a company policy file Vector cannot read turns Local on with no web only where it was on", () => {
    writeManaged({ local: { enabled: true } })
    const file = path.join(managedDirectory, "vector.json")
    chmodSync(file, 0o000)
    try {
      // Vector Local was off for this user: it stays off, and the pane says why.
      const off = Config.refreshLocal()
      expect(off.enabled).toBe(false)
      expect(off.warnings).toHaveLength(1)
      expect(off.warnings[0]).toStartWith(`Vector could not check who may change ${file}: `)
      process.env.VECTOR_LOCAL = "1"
      expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "none" })
    } finally {
      chmodSync(file, 0o644)
    }
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
