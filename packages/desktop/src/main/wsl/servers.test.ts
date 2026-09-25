import { expect, test } from "bun:test"
import {
  clearWslDistroState,
  requireWslIpcString,
  requireWslIpcStrings,
  wslServerIdToRestart,
  wslTerminalArgs,
} from "./policy"
import {
  expectVectorVersion,
  pendingRestartAfterWslInstall,
  pollWslHealth,
  wslServerIdsToStartOnInitialize,
} from "./startup"
import { createWslServersController, type WslServerConfig } from "./servers"

let persistedServers: WslServerConfig[] = []
let releaseVectorResolve: (() => void) | undefined

test("starts every configured WSL server on initialization", () => {
  expect(
    wslServerIdsToStartOnInitialize([
      { id: "wsl:Debian", distro: "Debian" },
      { id: "wsl:Ubuntu-24.04", distro: "Ubuntu-24.04" },
    ]),
  ).toEqual(["wsl:Debian", "wsl:Ubuntu-24.04"])
})

test("rejects an update that did not install the Vector desktop version", () => {
  expect(() => expectVectorVersion("1.16.2", "1.16.2")).not.toThrow()
  expect(() => expectVectorVersion("1.14.35", "1.16.2")).toThrow(
    "Update Vector in Debian before starting this server: installed 1.14.35; desktop requires 1.16.2",
  )
})

test("restarts an existing distro server after updating the engine", () => {
  expect(
    wslServerIdToRestart(
      [
        {
          config: { id: "wsl:Debian", distro: "Debian" },
          runtime: { kind: "ready", url: "", username: null, password: null },
        },
      ],
      "Debian",
    ),
  ).toBe("wsl:Debian")
  expect(wslServerIdToRestart([], "Debian")).toBeUndefined()
})

test("clears cached distro probes when removing a WSL server", () => {
  expect(
    clearWslDistroState(
      { Debian: { name: "Debian", canExecute: true, hasBash: true, hasInstallTools: true, error: null } },
      {
        Debian: {
          distro: "Debian",
          resolvedPath: "/home/luke/.vector/bin/vector",
          version: "1.16.2",
          expectedVersion: "1.16.2",
          matchesRequired: true,
          error: null,
        },
      },
      "Debian",
    ),
  ).toEqual({ distroProbes: {}, vectorChecks: {} })
})

test("opens terminals for distro names containing spaces", () => {
  expect(wslTerminalArgs("Ubuntu Preview")).toEqual(["/c", "start", "", "wsl", "-d", "Ubuntu Preview"])
})

test("stops health polling when sidecar startup settles", async () => {
  const abort = new AbortController()
  let checks = 0
  const polling = pollWslHealth(
    async () => {
      checks++
      return false
    },
    abort.signal,
    1,
  )

  await new Promise((resolve) => setTimeout(resolve, 5))
  abort.abort()
  await polling
  const settled = checks
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(checks).toBe(settled)
})

test("validates WSL IPC identifiers at the module boundary", () => {
  expect(requireWslIpcString("distro", "Debian")).toBe("Debian")
  expect(requireWslIpcStrings("distro", ["Debian", "Ubuntu"])).toEqual(["Debian", "Ubuntu"])
  expect(() => requireWslIpcString("distro", "")).toThrow("Invalid distro")
  expect(() => requireWslIpcString("server id", undefined)).toThrow("Invalid server id")
  expect(() => requireWslIpcStrings("distro", [])).toThrow("Invalid distro")
})

test("derives a required Windows restart from the post-install runtime probe", () => {
  expect(pendingRestartAfterWslInstall({ available: false, version: null, error: "WSL unavailable" })).toBe(true)
  expect(pendingRestartAfterWslInstall({ available: true, version: "WSL version: 2.6.1", error: null })).toBe(false)
})

test("ignores stale background engine checks after removing a WSL server", async () => {
  persistedServers = []
  releaseVectorResolve = undefined
  const controller = createWslServersController(
    "1.16.2",
    async () => ({
      listener: {
        stop: async () => undefined,
        onExit: () => undefined,
      },
      url: "http://127.0.0.1:4096",
      username: "vector",
      password: "secret",
    }),
    testControllerOptions(),
  )

  await controller.replaceAccount("vct_synthetic")
  await controller.addServer("Debian")
  await waitFor(() => !!releaseVectorResolve)
  await controller.removeServer("wsl:Debian")
  releaseVectorResolve?.()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(controller.getState().servers).toEqual([])
  expect(controller.getState().vectorChecks).toEqual({})
})

test("ignores stale startup engine checks after removing a WSL server", async () => {
  persistedServers = [{ id: "wsl:Debian", distro: "Debian" }]
  releaseVectorResolve = undefined
  const controller = createWslServersController(
    "1.16.2",
    async () => new Promise<never>(() => undefined),
    testControllerOptions(),
  )

  await controller.replaceAccount("vct_synthetic")
  await controller.initialize()
  await waitFor(() => !!releaseVectorResolve)
  await controller.removeServer("wsl:Debian")
  releaseVectorResolve?.()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(controller.getState().servers).toEqual([])
  expect(controller.getState().vectorChecks).toEqual({})
})

test("probes addable distros in parallel before checking the engine", async () => {
  persistedServers = []
  const started: string[] = []
  const release = new Map<string, () => void>()
  const vector: string[] = []
  const controller = createWslServersController("1.16.2", async () => new Promise<never>(() => undefined), {
    ...testControllerOptions(),
    probeDistro: async (distro) => {
      started.push(distro)
      await new Promise<void>((resolve) => release.set(distro, resolve))
      return { name: distro, canExecute: true, hasBash: true, hasInstallTools: true, error: null }
    },
    resolveVector: async (distro) => {
      vector.push(distro)
      return "/home/me/.vector/bin/vector"
    },
  })

  const task = controller.probeAddable(["Debian", "Ubuntu"])
  await waitFor(() => started.length === 2)
  expect(started).toEqual(["Debian", "Ubuntu"])
  expect(vector).toEqual([])
  release.get("Debian")?.()
  release.get("Ubuntu")?.()
  await task

  expect(Object.keys(controller.getState().distroProbes)).toEqual(["Debian", "Ubuntu"])
  expect(vector).toEqual(["Debian", "Ubuntu"])
  expect(Object.keys(controller.getState().vectorChecks)).toEqual(["Debian", "Ubuntu"])
})

test("does not check the engine in addable distros that cannot execute commands", async () => {
  persistedServers = []
  const vector: string[] = []
  const controller = createWslServersController("1.16.2", async () => new Promise<never>(() => undefined), {
    ...testControllerOptions(),
    probeDistro: async (distro) => ({
      name: distro,
      canExecute: distro === "Debian",
      hasBash: distro === "Debian",
      hasInstallTools: distro === "Debian",
      error: distro === "Debian" ? null : "Open Ubuntu once to finish setup",
    }),
    resolveVector: async (distro) => {
      vector.push(distro)
      return "/home/me/.vector/bin/vector"
    },
  })

  await controller.probeAddable(["Debian", "Ubuntu"])

  expect(Object.keys(controller.getState().distroProbes)).toEqual(["Debian", "Ubuntu"])
  expect(vector).toEqual(["Debian"])
  expect(Object.keys(controller.getState().vectorChecks)).toEqual(["Debian"])
})

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for condition")
}

function testControllerOptions() {
  return {
    readServers: () => persistedServers,
    writeServers: (servers: WslServerConfig[]) => {
      persistedServers = servers
    },
    readCommandVersion: async () => "1.16.2",
    resolveVector: async () => {
      await new Promise<void>((resolve) => {
        releaseVectorResolve = resolve
      })
      return "/home/me/.vector/bin/vector"
    },
  }
}

for (const version of [null, "1.16.1", "1.16.3"]) {
  test(`refuses to launch a WSL engine reporting ${version}`, async () => {
    const spawned: string[] = []
    const controller = createWslServersController(
      "1.16.2",
      async (distro) => {
        spawned.push(distro)
        throw new Error("must not launch")
      },
      {
        readServers: () => [{ id: "wsl:Debian", distro: "Debian" }],
        writeServers: () => undefined,
        resolveVector: async () => (version === null ? null : "/home/me/.vector/bin/vector-native"),
        readCommandVersion: async () => version,
      },
    )
    await controller.replaceAccount("vct_synthetic")
    await controller.initialize()
    await waitFor(() => controller.getState().servers[0]?.runtime.kind === "failed")
    expect(spawned).toEqual([])
    const runtime = controller.getState().servers[0].runtime
    expect(runtime.kind).toBe("failed")
    if (runtime.kind !== "failed") throw new Error("Expected failed runtime")
    expect(runtime.message).toContain(version === null ? "needs Vector installed again" : "Update Vector in Debian")
    expect(runtime.message).toContain("server settings")
    expect(controller.getState().vectorChecks.Debian.matchesRequired).not.toBe(true)
  })
}

test("rechecks the actual engine version before every start", async () => {
  let version = "1.16.2"
  let spawned = 0
  let stopped = 0
  const controller = createWslServersController(
    "1.16.2",
    async () => {
      spawned++
      return {
        listener: {
          stop: async () => {
            stopped++
          },
          onExit: () => undefined,
        },
        url: "http://127.0.0.1:4096",
        username: "vector",
        password: "fixture-password",
      }
    },
    {
      readServers: () => [{ id: "wsl:Debian", distro: "Debian" }],
      writeServers: () => undefined,
      resolveVector: async () => "/home/me/.vector/bin/vector-native",
      readCommandVersion: async () => version,
    },
  )
  await controller.replaceAccount("vct_synthetic")
  await controller.initialize()
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")
  expect(spawned).toBe(1)
  version = "1.16.1"
  await controller.startServer("wsl:Debian")
  expect(spawned).toBe(1)
  expect(stopped).toBe(1)
  expect(controller.getState().servers[0].runtime.kind).toBe("failed")
})

test("a missing desktop account refuses WSL startup before launching a process", async () => {
  let spawned = 0
  const controller = createWslServersController(
    "1.16.2",
    async () => {
      spawned++
      throw new Error("must not launch")
    },
    {
      readServers: () => [{ id: "wsl:Debian", distro: "Debian" }],
      writeServers: () => {},
      resolveVector: async () => "/fixture/native",
      readCommandVersion: async () => "1.16.2",
    },
  )
  await controller.initialize()
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "failed")
  expect(spawned).toBe(0)
  expect(JSON.stringify(controller.getState())).toContain("Sign in to your Vector account in the desktop app")
})

test("rotation waits for old sidecar termination and emits no account token", async () => {
  const closed = Promise.withResolvers<void>()
  const tokens: string[] = []
  const events: unknown[] = []
  const controller = createWslServersController(
    "1.16.2",
    async (_distro, input) => {
      tokens.push(input.token)
      return {
        listener: { stop: () => (input.token === "vct_old" ? closed.promise : Promise.resolve()), onExit: () => {} },
        url: "http://127.0.0.1:1",
        username: "vector",
        password: "synthetic",
      }
    },
    {
      readServers: () => [{ id: "wsl:Debian", distro: "Debian" }],
      writeServers: () => {},
      resolveVector: async () => "/fixture/native",
      readCommandVersion: async () => "1.16.2",
    },
  )
  controller.subscribe((event) => events.push(event))
  await controller.replaceAccount("vct_old")
  await controller.initialize()
  await waitFor(() => tokens.length === 1)
  let synchronized = false
  const rotation = controller.replaceAccount("vct_new", async () => {
    synchronized = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(synchronized).toBe(false)
  expect(tokens).toEqual(["vct_old"])
  closed.resolve()
  await rotation
  expect(tokens).toEqual(["vct_old", "vct_new"])
  expect(JSON.stringify(events)).not.toContain("vct_")
  await controller.replaceAccount(undefined)
  expect(controller.getState().servers[0]?.runtime.kind).toBe("failed")
})

test("logout fences an in-flight start and waits for its eventual termination", async () => {
  const ready = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  let launched = false
  let stopCalled = false
  const controller = createWslServersController(
    "1.16.2",
    async () => {
      launched = true
      await ready.promise
      return {
        listener: {
          stop: () => {
            stopCalled = true
            return stopped.promise
          },
          onExit: () => {},
        },
        url: "http://127.0.0.1:1",
        username: "vector",
        password: "synthetic",
      }
    },
    {
      readServers: () => [{ id: "wsl:Debian", distro: "Debian" }],
      writeServers: () => {},
      resolveVector: async () => "/fixture/native",
      readCommandVersion: async () => "1.16.2",
    },
  )
  await controller.replaceAccount("vct_old")
  await controller.initialize()
  await waitFor(() => launched)
  let done = false
  const logout = controller.replaceAccount(undefined).then(() => {
    done = true
  })
  ready.resolve()
  await waitFor(() => stopCalled)
  expect(done).toBe(false)
  stopped.resolve()
  await logout
  expect(controller.getState().servers[0]?.runtime.kind).not.toBe("ready")
})

test("failed termination blocks logout completion and later generations cannot revive an older token", async () => {
  let canStop = false
  const tokens: string[] = []
  const controller = createWslServersController(
    "1.16.2",
    async (_distro, input) => {
      tokens.push(input.token)
      return {
        listener: {
          stop: async () => {
            if (!canStop) throw new Error("still alive")
          },
          onExit: () => {},
        },
        url: "http://127.0.0.1:1",
        username: "vector",
        password: "synthetic",
      }
    },
    {
      readServers: () => [{ id: "wsl:Debian", distro: "Debian" }],
      writeServers: () => {},
      resolveVector: async () => "/fixture/native",
      readCommandVersion: async () => "1.16.2",
    },
  )
  await controller.replaceAccount("vct_old")
  await controller.initialize()
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")
  let synchronized = false
  await expect(
    controller.replaceAccount(undefined, async () => {
      synchronized = true
    }),
  ).rejects.toThrow("could not confirm")
  expect(synchronized).toBe(false)
  canStop = true
  const blocked = Promise.withResolvers<void>()
  const first = controller.replaceAccount("vct_superseded", () => blocked.promise)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const final = controller.replaceAccount("vct_final")
  blocked.resolve()
  await Promise.all([first, final])
  expect(tokens).toEqual(["vct_old", "vct_final"])
  await controller.stopAll()
})

test("account synchronization is serialized so a slow old account cannot overwrite the new account", async () => {
  const controller = createWslServersController(
    "1.16.2",
    async () => {
      throw new Error("No servers configured")
    },
    {
      readServers: () => [],
      writeServers: () => {},
    },
  )
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const synchronized: string[] = []
  const first = controller.replaceAccount("vct_old", async () => {
    entered.resolve()
    await release.promise
    synchronized.push("old")
  })
  await entered.promise
  const second = controller.replaceAccount("vct_final", async () => {
    synchronized.push("final")
  })
  expect(synchronized).toEqual([])
  release.resolve()
  await Promise.all([first, second])
  expect(synchronized).toEqual(["old", "final"])
})

test("an unhealthy process remains owned until confirmed stopped, including startup cancellation", async () => {
  let stopAllowed = false
  let started = false
  let aborted = false
  const controller = createWslServersController(
    "1.16.2",
    async (_distro, input) => {
      const untrack = input.onStart(async () => {
        if (!stopAllowed) throw new Error("still alive")
        untrack()
      })
      started = true
      await new Promise<void>((resolve) =>
        input.signal.addEventListener(
          "abort",
          () => {
            aborted = true
            resolve()
          },
          { once: true },
        ),
      )
      throw new DOMException("Aborted", "AbortError")
    },
    {
      readServers: () => [{ id: "wsl:Debian", distro: "Debian" }],
      writeServers: () => {},
      resolveVector: async () => "/fixture/native",
      readCommandVersion: async () => "1.16.2",
    },
  )
  await controller.replaceAccount("vct_fixture")
  await controller.initialize()
  await waitFor(() => started)
  let synchronized = false
  await expect(
    controller.replaceAccount(undefined, async () => {
      synchronized = true
    }),
  ).rejects.toThrow("could not confirm")
  expect(aborted).toBe(true)
  expect(synchronized).toBe(false)
  stopAllowed = true
  await controller.replaceAccount(undefined, async () => {
    synchronized = true
  })
  expect(synchronized).toBe(true)
  expect(controller.getState().servers[0]?.runtime.kind).not.toBe("ready")
})
