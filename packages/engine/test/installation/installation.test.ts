import { describe, expect } from "bun:test"
import { makeGlobalNode } from "@vectordevai/core/effect/app-node"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { Effect, Layer, Stream, Sink } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { InstallationVersion } from "@vectordevai/core/installation/version"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

describe("Vector installation", () => {
  for (const method of ["npm", "bun", "pnpm"] as const) {
    const calls: string[] = []
    testEffect(
      testLayer((request) => {
        calls.push(request.url)
        return jsonResponse({ version: "1.99.92" })
      }),
    ).effect(`${method} uses only the Vector registry package`, () =>
      Effect.gen(function* () {
        expect(yield* Installation.use.latest(method)).toBe("1.99.92")
        expect(calls).toEqual(["https://registry.npmjs.org/@vectordevai%2fcli/latest"])
      }),
    )
  }

  for (const method of ["npm", "pnpm", "bun"] as const) {
    const commands: string[][] = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (command, args) => {
          commands.push([command, ...args])
          return ""
        },
      ),
    ).effect(`${method} installs the scoped Vector CLI`, () =>
      Effect.gen(function* () {
        yield* Installation.use.upgrade(method, "1.99.92")
        expect(commands[0]).toEqual([method, "install", "-g", "@vectordevai/cli@1.99.92"])
      }),
    )
  }

  testEffect(
    testLayer(
      () => jsonResponse({}),
      () => "other-cli@1.18.0",
    ),
  ).effect("never mistakes an unrelated package for Vector", () =>
    Effect.gen(function* () {
      expect(yield* Installation.use.method()).toBe("unknown")
    }),
  )

  testEffect(
    testLayer(
      () => jsonResponse({}),
      (command) => (command === "npm" ? "@vectordevai/cli@1.99.91" : ""),
    ),
  ).effect("does not infer npm ownership from a global package listing", () =>
    Effect.gen(function* () {
      expect(yield* Installation.use.method()).toBe("unknown")
    }),
  )

  testEffect(
    testLayer(
      () => jsonResponse({}),
      (command) => (command === "pnpm" ? "@vectordevai/cli 1.99.91" : ""),
    ),
  ).effect("does not infer pnpm ownership from a global package listing", () =>
    Effect.gen(function* () {
      expect(yield* Installation.use.method()).toBe("unknown")
    }),
  )

  testEffect(
    testLayer(
      () => jsonResponse({}),
      () => ({ code: 1, stderr: "secret-token" }),
    ),
  ).effect("sanitizes package-manager failures", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Installation.use.upgrade("npm", "1.99.92"))
      expect(error.stderr).toBe("Upgrade failed for npm (exit code 1).")
      expect(error.stderr).not.toContain("secret-token")
    }),
  )

  const local = { requests: [] as string[], commands: [] as string[][] }
  testEffect(
    testLayer(
      (request) => {
        local.requests.push(request.url)
        return jsonResponse({ version: "1.99.92" })
      },
      (command, args) => {
        local.commands.push([command, ...args])
        return ""
      },
    ),
  ).effect("with Vector Local on, checks only when asked and upgrades only once the check was confirmed", () =>
    Effect.gen(function* () {
      Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))
      // Automatic checks are off: the running version is reported, and nothing is sent.
      expect(yield* Installation.use.latest("npm")).toBe(InstallationVersion)
      expect(local.requests).toEqual([])
      // The package manager is a program of its own, so it never starts before the person confirms the check.
      const refused = yield* Effect.flip(Installation.use.upgrade("npm", "1.99.92"))
      expect(refused.stderr).toBe(
        "Vector Local is on, so Vector asks before it checks for or installs a new version. Run vector upgrade in a terminal to confirm.",
      )
      expect(local.commands.filter((command) => command.includes("install"))).toEqual([])
      // vector upgrade asked and the person said yes.
      Egress.grant("updates", { once: false })
      expect(yield* Installation.use.latest("npm", { manual: true })).toBe("1.99.92")
      yield* Installation.use.upgrade("npm", "1.99.92")
      expect(local.commands).toContainEqual(["npm", "install", "-g", "@vectordevai/cli@1.99.92"])
    }).pipe(Effect.ensuring(Effect.sync(() => Egress.configure(LocalPolicy.OFF)))),
  )

  testEffect(
    testLayer(
      () => jsonResponse({}),
      () => {
        throw new Error("must not spawn")
      },
    ),
  ).effect("unknown installs cannot download an upstream installer", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(Installation.use.upgrade("unknown", "1.99.92"))).message).toContain(
        "could not verify this executable's installation channel",
      )
      expect((yield* Effect.flip(Installation.use.upgrade("npm", "--help"))).message).toContain(
        "Invalid Vector version",
      )
    }),
  )
})
