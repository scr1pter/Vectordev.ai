import { beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { freeID, sinceOf } from "../../src/cli/cmd/local"
import { cliIt } from "../lib/cli-process"
import { LocalServers } from "../../../core/test/fixture/local-servers/serve"

// `vector local` and `vector run --local` as a person runs them: the real CLI in a home folder of its own, against
// fake model servers on 127.0.0.1. What would loosen Vector Local is refused under the agent marker and without a
// terminal; the check's exit status says whether every layer passed; the network log prints as JSON; and --local turns
// Vector Local on for one run without changing a setting.

const AGENT = { VECTOR_AGENT_SESSION: "ses_agent", VECTOR_LOCAL: "1" }

// The CLI runs as the owner runs it in their own terminal: without the agent marker, which every child of a process
// that resolved Vector Local otherwise inherits. The agent's own runs pass it themselves.
beforeEach(() => {
  ChildEnvironment.inherit({ agent: false })
})

const configFile = (home: string) => path.join(home, ".config", "vector", "vector.json")
const writeConfig = (home: string, value: Record<string, unknown>) => {
  mkdirSync(path.dirname(configFile(home)), { recursive: true })
  writeFileSync(configFile(home), JSON.stringify(value, null, 2))
}
const readConfig = (home: string) =>
  existsSync(configFile(home)) ? (JSON.parse(readFileSync(configFile(home), "utf8")) as Record<string, any>) : {}

// A fake Ollama on 127.0.0.1 for the test's scope, with its identity pin as Add server records it.
const ollama = (routes?: Record<string, LocalServers.Route>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const fake = await LocalServers.serve("ollama", { routes })
      const server = await LocalProbe.probe(fake.origin)
      return { fake, pin: server!.pin }
    }),
    (item) => Effect.promise(() => item.fake.close()),
  )

// The user's own config with Vector Local on, the fake server on the list and pinned, and a provider for its models.
const listed = (home: string, origin: string, pin: LocalProbe.Pin) =>
  writeConfig(home, {
    local: { enabled: true, endpoints: [origin], pins: { [origin]: pin } },
    provider: {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama (test)",
        options: { baseURL: `${origin}/v1` },
        models: { "qwen3-coder:30b": { name: "qwen3-coder:30b", tool_call: true } },
      },
    },
  })

describe("vector local", () => {
  cliIt.live(
    "refuses to loosen Vector Local under the agent marker, but still tightens it",
    ({ vector, home }) =>
      Effect.gen(function* () {
        writeConfig(home, { local: { enabled: true } })
        const off = yield* vector.spawn(["local", "off"], { env: AGENT })
        vector.expectExit(off, 1)
        expect(off.stderr).toContain(
          "An agent or Vector's own terminal started this Vector, so it cannot loosen Vector Local.",
        )
        const allow = yield* vector.spawn(["local", "allow", "github", "--reason", "Pull requests"], { env: AGENT })
        vector.expectExit(allow, 1)
        expect(allow.stderr).toContain("cannot loosen Vector Local")
        expect(readConfig(home).local).toEqual({ enabled: true })
        // A stricter Web access is a tightening, which the marker does not stop.
        const web = yield* vector.spawn(["local", "web", "none"], { env: AGENT })
        vector.expectExit(web, 0)
        expect(readConfig(home).local).toEqual({ enabled: true, web: "none" })
      }),
    60_000,
  )

  cliIt.live(
    "asks at a terminal before loosening, so without one nothing changes",
    ({ vector, home }) =>
      Effect.gen(function* () {
        writeConfig(home, { local: { enabled: true, web: "none" } })
        const ask = yield* vector.spawn(["local", "web", "ask"])
        vector.expectExit(ask, 1)
        expect(ask.stderr).toContain("This change would loosen Vector Local, so it needs your answer at a terminal.")
        expect(ask.stderr).toContain("It sets Web access to Ask.")
        const off = yield* vector.spawn(["local", "off"])
        vector.expectExit(off, 1)
        expect(readConfig(home).local).toEqual({ enabled: true, web: "none" })
        const status = yield* vector.spawn(["local", "status", "--json"])
        vector.expectExit(status, 0)
        expect(JSON.parse(status.stdout).policy).toMatchObject({ enabled: true, web: "none" })
      }),
    60_000,
  )

  cliIt.live(
    "vector local check exits 2 when off, 0 when every layer passes, and 1 once a listed server stops answering",
    ({ vector, home }) =>
      Effect.gen(function* () {
        const off = yield* vector.spawn(["local", "check"])
        vector.expectExit(off, 2)
        expect(off.stderr).toContain("Vector Local is off")

        const server = yield* ollama()
        listed(home, server.fake.origin, server.pin)
        const pass = yield* vector.spawn(["local", "check", "--json"])
        vector.expectExit(pass, 0)
        const report = JSON.parse(pass.stdout)
        expect(report.result).toBe("pass")
        expect(report.rows.find((row: { layer: string }) => row.layer === "models")).toMatchObject({
          status: "pass",
          title: "Models Vector may call: ollama (1)",
          // The test harness's own provider points at a server that is not on the list.
          detail: "Off in Vector Local: lmstudio.",
        })

        yield* Effect.promise(() => server.fake.close())
        const fail = yield* vector.spawn(["local", "check"])
        vector.expectExit(fail, 1)
        expect(fail.stderr).toContain(`Nothing answered at ${server.fake.origin}`)
      }),
    60_000,
  )

  cliIt.live(
    "vector local log --json prints what Vector sent, origins only, and filters it",
    ({ vector, home }) =>
      Effect.gen(function* () {
        const server = yield* ollama()
        listed(home, server.fake.origin, server.pin)
        // Check reads the listed server, which the network log records.
        vector.expectExit(yield* vector.spawn(["local", "check"]), 0)
        const log = yield* vector.spawn(["local", "log", "--json"])
        vector.expectExit(log, 0)
        const events = JSON.parse(log.stdout) as { source: string; origin: string; decision: string }[]
        expect(events.length).toBeGreaterThan(0)
        expect(
          events.filter((event) => event.source === LocalProbe.SERVER_CHECK).map((event) => event.origin),
        ).toContain(server.fake.origin)
        expect(events.every((event) => !event.origin.includes("/api/"))).toBe(true)
        const blocked = yield* vector.spawn(["local", "log", "--json", "--blocked"])
        vector.expectExit(blocked, 0)
        expect(
          (JSON.parse(blocked.stdout) as { decision: string }[]).every((event) => event.decision !== "allow"),
        ).toBe(true)
        const future = yield* vector.spawn(["local", "log", "--json", "--since", "2999-01-01"])
        expect(JSON.parse(future.stdout)).toEqual([])
        const wrong = yield* vector.spawn(["local", "log", "--since", "soon"])
        vector.expectExit(wrong, 1)
        expect(wrong.stderr).toContain("--since takes a span such as 30m, 2h or 7d, or a date")
      }),
    60_000,
  )
})

describe("vector run --local", () => {
  cliIt.live(
    "turns Vector Local on for this run only, so an unlisted model server gets no prompt",
    ({ vector, home, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* vector.run("say hi", { extraArgs: ["--local"] })
        expect(result.exitCode).not.toBe(0)
        expect(`${result.stdout}${result.stderr}`).toContain("off in Vector Local")
        expect(yield* llm.calls).toBe(0)
        // Nothing was written: the user's config has no local block.
        expect(readConfig(home).local).toBeUndefined()
      }),
    60_000,
  )

  cliIt.live(
    "never loosens what the user set: a listed server still answers, with Web access as it was",
    ({ vector, home, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const origin = new URL(llm.url).origin
        writeConfig(home, { local: { enabled: false, web: "none", endpoints: [origin] } })
        const result = yield* vector.run("say hi", { extraArgs: ["--local"] })
        vector.expectExit(result, 0)
        expect(result.stdout).toContain("hello from the test llm")
        expect(readConfig(home).local).toEqual({ enabled: false, web: "none", endpoints: [origin] })
        // The next run without --local is as the user's config says: Vector Local off.
        const status = yield* vector.spawn(["local", "status", "--json"])
        expect(JSON.parse(status.stdout).policy).toMatchObject({ enabled: false, web: "none" })
      }),
    60_000,
  )
})

describe("vector local helpers", () => {
  test("--since takes a span back from now, or a date", () => {
    const now = Date.parse("2026-10-22T12:00:00Z")
    expect(sinceOf("30m", now)).toBe(now - 30 * 60_000)
    expect(sinceOf("2h", now)).toBe(now - 2 * 3_600_000)
    expect(sinceOf("7d", now)).toBe(now - 7 * 86_400_000)
    expect(sinceOf("2026-10-01", now)).toBe(Date.parse("2026-10-01"))
    expect(sinceOf("soon", now)).toBeNull()
  })

  test("a server's provider name is its kind, numbered when that is taken", () => {
    expect(freeID("ollama", [])).toBe("ollama")
    expect(freeID("ollama", ["ollama", "ollama-2"])).toBe("ollama-3")
  })
})
