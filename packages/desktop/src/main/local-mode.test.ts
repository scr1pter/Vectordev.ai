import { afterEach, describe, expect, test } from "bun:test"
import { X509Certificate } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { getCACertificates } from "node:tls"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { createEgressFilter } from "./egress-filter"
import { companyCertificates } from "./local-certificates"
import {
  answeredByEngine,
  connectDesktopLocal,
  createFirstRunHold,
  createUpdateGate,
  denyPeerConnections,
  desktopLocalStatus,
  firstRunHeld,
  forwardEgress,
  installChromiumLocal,
  policyMismatch,
  startFirstRun,
  stricterPolicy,
  trustCompanyCertificates,
  usageCheckinAllowed,
  watchCompanyCertificates,
  watchFirstRun,
} from "./local-mode"

const FIXTURE = path.join(import.meta.dir, "../../test/fixture/local-ca")
const pem = (name: string) => readFileSync(path.join(FIXTURE, `${name}.pem`), "utf8")
const on = (local: Parameters<typeof LocalPolicy.resolve>[0]["global"] = {}) =>
  LocalPolicy.resolve({ global: { enabled: true, endpoints: ["http://127.0.0.1:11434"], ...local } })
const temporary: string[] = []
const folder = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vector-local-mode-"))
  temporary.push(dir)
  return dir
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

afterEach(() => {
  Egress.configure(LocalPolicy.OFF)
  temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

describe("Chromium under Vector Local", () => {
  const sessions = () => {
    const made = new Map<string, ReturnType<typeof fake>>()
    const fake = () => ({
      listeners: 0,
      preloads: [] as { type: string; id?: string; filePath: string }[],
      webRequest: { onBeforeRequest: () => void made.size },
      registerPreloadScript(script: { type: "frame" | "service-worker"; id?: string; filePath: string }) {
        this.preloads.push(script)
        return script.id ?? "preload"
      },
    })
    return {
      made,
      fromPartition: (name: string) => made.get(name) ?? made.set(name, fake()).get(name)!,
      defaultSession: fake(),
    }
  }

  test("sets the WebRTC policy on every new web contents, and on those already open", () => {
    const local = { current: on() }
    const filter = createEgressFilter({ policy: () => local.current, record: () => undefined })
    const app = new EventEmitter()
    const policies: string[] = []
    const contents = (name: string) => ({
      setWebRTCIPHandlingPolicy: (value: string) => void policies.push(`${name} ${value}`),
    })
    const made = sessions()
    installChromiumLocal({
      app: app as never,
      defaultSession: made.defaultSession,
      fromPartition: made.fromPartition,
      webContents: () => [contents("open")],
      directory: folder(),
      filter,
      policy: () => local.current,
    })
    app.emit("web-contents-created", {}, contents("new"))
    expect(policies).toEqual(["open disable_non_proxied_udp", "new disable_non_proxied_udp"])
    // With Vector Local off a web contents keeps Chromium's own WebRTC routing.
    local.current = LocalPolicy.OFF
    app.emit("web-contents-created", {}, contents("later"))
    expect(policies).toHaveLength(2)
  })

  test("labels the agent's browser and the updater, and turns peer connections off in the agent's browser", () => {
    const directory = folder()
    const recorded: string[] = []
    const filter = createEgressFilter({ policy: on, record: (request) => void recorded.push(request.source) })
    const made = sessions()
    const app = new EventEmitter()
    installChromiumLocal({
      app: app as never,
      defaultSession: made.defaultSession,
      fromPartition: made.fromPartition,
      webContents: () => [],
      directory,
      filter,
      policy: on,
    })
    expect([...made.made.keys()]).toEqual(["persist:vector-browser", "electron-updater"])
    const agent = made.made.get("persist:vector-browser")!
    expect(agent.preloads).toEqual([
      {
        type: "frame",
        id: "vector-local-no-peer-connections",
        filePath: path.join(directory, "no-peer-connections.js"),
      },
    ])
    const script = readFileSync(agent.preloads[0]!.filePath, "utf8")
    expect(script).toContain("RTCPeerConnection")
    expect(script).toContain("executeInMainWorld")
    if (process.platform !== "win32") expect(statSync(agent.preloads[0]!.filePath).mode & 0o777).toBe(0o600)
    // A session Electron makes later gets the dispatcher too.
    const later = { listener: false, webRequest: { onBeforeRequest: () => void (later.listener = true) } }
    app.emit("session-created", later)
    expect(later.listener).toBe(true)
  })

  test("writes no preload with Vector Local off", () => {
    const made = sessions()
    installChromiumLocal({
      app: new EventEmitter() as never,
      defaultSession: made.defaultSession,
      fromPartition: made.fromPartition,
      webContents: () => [],
      directory: folder(),
      filter: createEgressFilter({ policy: () => LocalPolicy.OFF, record: () => undefined }),
      policy: () => LocalPolicy.OFF,
    })
    expect(made.made.get("persist:vector-browser")!.preloads).toEqual([])
  })

  test("registers the peer-connection preload from a folder only this user can open", () => {
    const directory = path.join(folder(), "local-mode")
    const registered: string[] = []
    denyPeerConnections(
      {
        registerPreloadScript: (script) => {
          registered.push(script.filePath)
          return "id"
        },
      },
      directory,
    )
    expect(registered).toEqual([path.join(directory, "no-peer-connections.js")])
    if (process.platform !== "win32") expect(statSync(directory).mode & 0o777).toBe(0o700)
  })
})

describe("the first-run hold", () => {
  test("holds on a first run only", () => {
    const base = { answered: false, managed: false, enabled: false, reported: false }
    expect(firstRunHeld(base)).toBe(true)
    expect(firstRunHeld({ ...base, answered: true })).toBe(false)
    // A company policy says how Vector runs before the app is ready, so nothing is held.
    expect(firstRunHeld({ ...base, managed: true })).toBe(false)
    // Vector Local already on blocks those requests itself.
    expect(firstRunHeld({ ...base, enabled: true })).toBe(false)
    // An install that already checked in has run before.
    expect(firstRunHeld({ ...base, reported: true })).toBe(false)
  })

  test("has no timeout, and resumes the held requests when the person answers", async () => {
    const hold = createFirstRunHold(true)
    const resumed: string[] = []
    void hold.answered().then(() => resumed.push("resumed"))
    const asked = { count: 0, answer: false }
    const stop = watchFirstRun(hold, {
      interval: 1,
      answered: async () => {
        asked.count++
        return asked.answer
      },
    })
    // Asked many times, with nothing chosen, it still holds: no number of checks or amount of time releases it.
    while (asked.count < 25) await settle()
    expect(hold.held()).toBe(true)
    expect(resumed).toEqual([])
    asked.answer = true
    await hold.answered()
    await settle()
    expect(hold.held()).toBe(false)
    expect(resumed).toEqual(["resumed"])
    const count = asked.count
    await settle()
    // Answered, it stops asking.
    expect(asked.count).toBe(count)
    stop()
  })

  test("holds the usage check-in and automatic update checks until the answer, and remembers the answer", async () => {
    const values = new Map<string, unknown>()
    const store = {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, value),
    }
    const userData = folder()
    // No company policy file on this computer, whatever the machine running the test has.
    const folders = { config: path.join(userData, "config"), managed: [path.join(userData, "managed")] }
    const start = () => startFirstRun({ userData, store, reported: false, folders })
    const hold = start()
    const gate = createUpdateGate({
      feed: () => "https://updates.example.test/vector/latest-mac.yml",
      ask: async () => true,
      tell: async () => undefined,
      during: (_origins, run) => run(),
    })
    expect(hold.held()).toBe(true)
    expect(usageCheckinAllowed("https://vectordev.ai/api/usage/checkin")).toBe(false)
    expect(gate.automatic()).toBe(false)
    // A check the person asks for is theirs to make, hold or not.
    expect(await gate.manual()).toBe(true)
    // Dismissing the card answers nothing: the next start holds again.
    expect(start().held()).toBe(true)
    const again = start()
    again.answer()
    await again.answered()
    await settle()
    expect(values.get("firstRunAnswered")).toBe(true)
    expect(usageCheckinAllowed("https://vectordev.ai/api/usage/checkin")).toBe(true)
    expect(gate.automatic()).toBe(true)
    expect(start().held()).toBe(false)
    // A company policy file means nothing is held, even on a first run.
    values.clear()
    mkdirSync(folders.managed[0]!, { recursive: true })
    writeFileSync(path.join(folders.managed[0]!, "vector.json"), JSON.stringify({ share: "disabled" }))
    expect(start().held()).toBe(false)
  })

  test("reads the answer from the engine: a model connected, Vector Local on, or a Vector sign-in", async () => {
    const engine = { url: "http://127.0.0.1:4096", password: "secret" }
    const answers = (provider: unknown, local: unknown) => async (input: string) => {
      const pathname = new URL(input).pathname
      return Response.json(pathname === "/provider" ? provider : local)
    }
    const none = { connected: [] }
    const off = { policy: { enabled: false } }
    expect(await answeredByEngine(engine, () => false, answers(none, off))).toBe(false)
    expect(await answeredByEngine(engine, () => false, answers({ connected: ["ollama"] }, off))).toBe(true)
    expect(await answeredByEngine(engine, () => false, answers(none, { policy: { enabled: true } }))).toBe(true)
    expect(await answeredByEngine(engine, () => true, answers(none, off))).toBe(true)
    // An engine that cannot answer has not been answered.
    expect(
      await answeredByEngine(
        engine,
        () => false,
        async () => new Response("down", { status: 503 }),
      ),
    ).toBe(false)
  })
})

describe("company certificate authorities", () => {
  test("are added after the certificates already trusted, so a public host's chain still verifies", () => {
    const company = path.join(folder(), "corp.pem")
    writeFileSync(company, `${pem("company-root")}\n${pem("company-root")}`)
    const base = [pem("public-root")]
    const trusted = companyCertificates(base, [company])
    expect(trusted.certificates).toEqual([pem("public-root"), pem("company-root").trim()])
    expect(trusted.problems).toEqual([])
    const verifies = (leaf: string) =>
      trusted.certificates.some((root) => {
        const anchor = new X509Certificate(root)
        const certificate = new X509Certificate(pem(leaf))
        return certificate.checkIssued(anchor) && certificate.verify(anchor.publicKey)
      })
    expect(verifies("public-leaf")).toBe(true)
    expect(verifies("company-leaf")).toBe(true)
  })

  test("leave out what is not a certificate authority, and say why", () => {
    const dir = folder()
    const leaf = path.join(dir, "leaf.pem")
    const text = path.join(dir, "notes.txt")
    writeFileSync(leaf, pem("public-leaf"))
    writeFileSync(text, "not a certificate")
    const trusted = companyCertificates([], [leaf, text, path.join(dir, "missing.pem")])
    expect(trusted.certificates).toEqual([])
    expect(trusted.problems).toEqual([
      `${leaf} holds a certificate for CN=public.web.test, not an authority.`,
      `${text} holds no PEM certificate.`,
      `Vector could not read the certificate file ${path.join(dir, "missing.pem")}.`,
    ])
  })

  test("are trusted in desktop main with every default certificate kept, and a change is noticed", async () => {
    const dir = folder()
    const config = path.join(dir, "config")
    const corp = path.join(dir, "corp.pem")
    writeFileSync(corp, pem("company-root"))
    mkdirSync(config, { recursive: true })
    writeFileSync(path.join(config, "vector.json"), JSON.stringify({ local: { ca: { files: [corp] } } }))
    const folders = { config, managed: [path.join(dir, "managed")], env: {} }
    const applied: string[][] = []
    const trusted = trustCompanyCertificates(dir, (certificates) => void applied.push(certificates), folders)
    const defaults = getCACertificates("default")
    expect(applied[0]!.length).toBeGreaterThan(defaults.length)
    expect(defaults.every((certificate) => applied[0]!.includes(certificate))).toBe(true)
    expect(applied[0]!.at(-1)).toBe(pem("company-root").trim())
    expect(trusted.added).toHaveLength(1)
    const changed: string[] = []
    const stop = watchCompanyCertificates({
      userData: dir,
      folders,
      interval: 1,
      apply: (certificates) => void applied.push(certificates),
      changed: () => void changed.push("changed"),
    })
    await settle()
    expect(changed).toEqual([])
    writeFileSync(corp, `${pem("company-root")}\n${pem("public-root")}`)
    while (changed.length === 0) await settle()
    stop()
    expect(applied.at(-1)!.slice(-2)).toEqual([pem("company-root").trim(), pem("public-root").trim()])
  })
})

describe("the app and its engine", () => {
  const engine = { url: "http://127.0.0.1:4096", password: "secret" }
  const serving = (policy: LocalMode.Policy) => async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${btoa("vector:secret")}`)
    if (url.pathname === "/local") return Response.json({ policy })
    return new Response("ok")
  }

  test("agree when they read the same policy", () => {
    expect(policyMismatch(on(), on())).toBeUndefined()
    expect(policyMismatch(LocalPolicy.OFF, LocalPolicy.OFF)).toBeUndefined()
    // Lists of a policy that is off do not apply, so they do not differ.
    expect(policyMismatch(LocalPolicy.OFF, { ...LocalPolicy.OFF, web: "none" })).toBeUndefined()
  })

  test("name every way they differ", () => {
    const desktop = on({ allow: [{ source: "github", reason: "Pull requests", added_at: 1, added_by: "app" }] })
    const engine = on({ web: "none", endpoints: ["http://127.0.0.1:1234"] })
    expect(policyMismatch(desktop, engine)?.differences).toEqual([
      "Web access is Ask in the app and None in its engine",
      "their model server lists differ",
      "their allowed services differ",
    ])
    expect(policyMismatch(LocalPolicy.OFF, engine)?.differences).toEqual([
      "Vector Local is off in the app and on in its engine",
    ])
  })

  test("the stricter policy lets through only what both let through", () => {
    const desktop = on({
      endpoints: ["http://127.0.0.1:11434", "http://gpu.lan:8000"],
      web_domains: { allow: ["intranet.corp.test", "docs.corp.test"], deny: ["ads.example.net"] },
      allow: [{ source: "github", reason: "Pull requests", added_at: 1, added_by: "app" }],
    })
    const engine = on({
      web: "network",
      endpoints: ["http://127.0.0.1:11434"],
      web_domains: { allow: ["intranet.corp.test"], deny: ["tracker.example.com"] },
    })
    const stricter = stricterPolicy(desktop, engine)
    expect(stricter).toMatchObject({
      enabled: true,
      web: "network",
      endpoints: [{ origin: "http://127.0.0.1:11434", from: "user" }],
      web_domains: { allow: ["intranet.corp.test"], deny: ["ads.example.net", "tracker.example.com"] },
      allow: [],
    })
    expect(stricterPolicy(LocalPolicy.OFF, engine)).toBe(engine)
    expect(stricterPolicy(desktop, LocalPolicy.OFF)).toBe(desktop)
  })

  test("show the mismatch error and use the stricter policy until they agree", async () => {
    Egress.configure(LocalPolicy.OFF)
    const engineLocal = { current: on({ web: "none" }) }
    const connection = connectDesktopLocal({
      engine,
      log: () => undefined,
      fetch: (input, init) => serving(engineLocal.current)(input, init),
      interval: 60_000,
    })
    await connection.compared
    expect(desktopLocalStatus().mismatch).toBe(
      "The app and its engine read Vector Local differently: Vector Local is off in the app and on in its engine. The app uses the stricter of the two until they agree, which usually takes a restart of Vector.",
    )
    expect(Egress.policy()).toMatchObject({ enabled: true, web: "none" })
    expect(desktopLocalStatus()).toMatchObject({ enabled: true, web: "none" })
    engineLocal.current = LocalPolicy.OFF
    await connection.compare()
    expect(desktopLocalStatus().mismatch).toBeUndefined()
    expect(Egress.policy().enabled).toBe(false)
    connection.stop()
  })

  test("keeps the app's own policy when the engine cannot say", async () => {
    Egress.configure(on())
    const connection = connectDesktopLocal({
      engine,
      log: () => undefined,
      fetch: async () => new Response("not found", { status: 404 }),
      interval: 60_000,
    })
    await connection.compared
    expect(desktopLocalStatus().mismatch).toBeUndefined()
    expect(Egress.policy()).toMatchObject({ enabled: true, web: "ask" })
    connection.stop()
  })

  test("sends what the app's own windows did to the engine's network log, in batches", async () => {
    const listeners = new Set<(event: LocalMode.Event) => void>()
    const sent: number[] = []
    const accept = { current: false }
    const forward = forwardEgress({
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      send: async (events) => {
        if (!accept.current) return false
        sent.push(events.length)
        return true
      },
      delay: 1,
      retry: 1,
      limit: 700,
    })
    const event = (id: number): LocalMode.Event => ({
      id: String(id),
      time: id,
      source: "agent-browser",
      purpose: "browser",
      class: "internet",
      origin: "https://example.org",
      method: "GET",
      decision: "allow",
      rule: "web-ask",
      reason: "Web access is set to Ask.",
      carried: { personal: 0, documents: 0, repository: 0 },
      resource: "page",
    })
    // The engine is not up yet: events wait, and the oldest go past the limit.
    for (let id = 0; id < 800; id++) listeners.forEach((listener) => listener(event(id)))
    await settle()
    expect(sent).toEqual([])
    accept.current = true
    while (sent.reduce((sum, count) => sum + count, 0) < 700) await settle()
    expect(sent).toEqual([500, 200])
    forward.stop()
    expect(listeners.size).toBe(0)
  })
})

describe("the updater under Vector Local", () => {
  const FEED = "https://updates.example.test/vector/latest-mac.yml"
  const gate = (policy: LocalMode.Policy, answer = true) => {
    const asked: string[] = []
    const granted: string[][] = []
    return {
      asked,
      granted,
      gate: createUpdateGate({
        feed: () => FEED,
        policy: () => policy,
        held: () => false,
        ask: async (question) => {
          asked.push(question.message)
          return answer
        },
        tell: async (notice) => void asked.push(notice.message),
        during: (origins, run) => {
          granted.push([...origins])
          return run()
        },
      }),
    }
  }

  test("checks as before with Vector Local off", async () => {
    const off = gate(LocalPolicy.OFF)
    expect(off.gate.automatic()).toBe(true)
    expect(await off.gate.manual()).toBe(true)
    expect(await off.gate.run(async () => "checked")).toBe("checked")
    expect(off.asked).toEqual([])
    expect(off.granted).toEqual([])
  })

  test("turns automatic checks off, and asks before each check the person starts", async () => {
    const local = gate(on())
    expect(local.gate.automatic()).toBe(false)
    expect(await local.gate.manual()).toBe(true)
    expect(await local.gate.manual()).toBe(true)
    expect(local.asked).toEqual(["Check for updates with Vector Local on?", "Check for updates with Vector Local on?"])
    expect(await local.gate.run(async () => "checked")).toBe("checked")
    expect(local.granted).toEqual([[FEED]])
    expect(await gate(on(), false).gate.manual()).toBe(false)
  })

  test("says why with Web access None, and checks a company mirror on its own", async () => {
    const none = gate(on({ web: "none" }))
    expect(await none.gate.manual()).toBe(false)
    expect(none.asked).toEqual(["Vector does not check for updates now"])
    const mirror = createUpdateGate({
      feed: () => "https://mirror.corp.test/vector/latest-mac.yml",
      policy: () =>
        LocalPolicy.resolve({ managed: { enabled: true, updates: { url: "https://mirror.corp.test/vector/" } } }),
      held: () => false,
      ask: async () => false,
      tell: async () => undefined,
      during: (_origins, run) => run(),
    })
    expect(mirror.automatic()).toBe(true)
    expect(await mirror.manual()).toBe(true)
  })
})

describe("what the app's windows may fetch", () => {
  test("follows Vector Local and what the user allowed", () => {
    Egress.configure(LocalPolicy.OFF)
    expect(desktopLocalStatus().sources).toEqual({
      "release-notes": "allow",
      "site-assets": "allow",
      "crash-reports": "allow",
      "dictation-model": "allow",
    })
    Egress.configure(on({ allow: [{ source: "release-notes", reason: "What changed", added_at: 1, added_by: "app" }] }))
    expect(desktopLocalStatus().sources).toEqual({
      "release-notes": "allow",
      "site-assets": "block",
      "crash-reports": "block",
      "dictation-model": "ask",
    })
    Egress.configure(on({ web: "none" }))
    expect(desktopLocalStatus().sources["dictation-model"]).toBe("block")
  })
})
