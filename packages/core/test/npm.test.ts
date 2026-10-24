import fs from "fs/promises"
import path from "path"
import { createServer } from "node:http"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Option } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { Global } from "@vectordevai/core/global"
import { Npm } from "@vectordevai/core/npm"
import { tmpdir } from "./fixture/tmpdir"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import type { ConfigLocalV1 } from "@vectordevai/core/v1/config/local"

const win = process.platform === "win32"

const writePackage = (dir: string, pkg: Record<string, unknown>) =>
  Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({
      version: "1.0.0",
      ...pkg,
    }),
  )

const npmLayer = (cache: string) =>
  AppNodeBuilder.build(Npm.node, [[Global.node, Global.layerWith({ cache, state: path.join(cache, "state") })]])

async function deadline<T>(promise: Promise<T>, label: string) {
  const limit = Promise.withResolvers<never>()
  const timer = setTimeout(() => limit.reject(new Error(`Timed out: ${label}`)), 2_000)
  return Promise.race([promise, limit.promise]).finally(() => clearTimeout(timer))
}

describe("Npm.sanitize", () => {
  test("keeps normal scoped package specs unchanged", () => {
    expect(Npm.sanitize("@vector/acme")).toBe("@vector/acme")
    expect(Npm.sanitize("@vector/acme@1.0.0")).toBe("@vector/acme@1.0.0")
    expect(Npm.sanitize("prettier")).toBe("prettier")
  })

  test("handles git https specs", () => {
    const spec = "acme@git+https://github.com/vector/acme.git"
    const expected = win ? "acme@git+https_//github.com/vector/acme.git" : spec
    expect(Npm.sanitize(spec)).toBe(expected)
  })
})

// The desktop engine runs on Node, where resolveEntryPoint uses packageEntry instead of Bun's import.meta.resolve.
describe("Npm.packageEntry", () => {
  const file = (dir: string, name: string, text = "export {}\n") =>
    fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true }).then(() => Bun.write(path.join(dir, name), text))

  test("picks the import condition of an ESM-only exports map", async () => {
    await using tmp = await tmpdir()
    await writePackage(tmp.path, {
      name: "esm-only",
      type: "module",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./package.json": "./package.json" },
    })
    await file(tmp.path, "dist/index.js")
    expect(Npm.packageEntry(tmp.path)).toBe(pathToFileURL(path.join(tmp.path, "dist", "index.js")).href)
  })

  test("matches conditions in package order like Node", async () => {
    await using tmp = await tmpdir()
    await writePackage(tmp.path, {
      name: "dual",
      exports: { require: "./dist/index.cjs", node: { import: "./dist/node.mjs" }, default: "./dist/index.mjs" },
    })
    await file(tmp.path, "dist/index.cjs", "module.exports = {}\n")
    await file(tmp.path, "dist/node.mjs")
    await file(tmp.path, "dist/index.mjs")
    expect(Npm.packageEntry(tmp.path)).toBe(pathToFileURL(path.join(tmp.path, "dist", "node.mjs")).href)
  })

  test("falls back to main, then index.js", async () => {
    await using main = await tmpdir()
    await writePackage(main.path, { name: "legacy", main: "lib/entry" })
    await file(main.path, "lib/entry.js", "module.exports = {}\n")
    expect(Npm.packageEntry(main.path)).toBe(pathToFileURL(path.join(main.path, "lib", "entry.js")).href)

    await using bare = await tmpdir()
    await file(bare.path, "index.js")
    expect(Npm.packageEntry(bare.path)).toBe(pathToFileURL(path.join(bare.path, "index.js")).href)
  })

  test("never returns the package directory", async () => {
    await using tmp = await tmpdir()
    await writePackage(tmp.path, { name: "empty", exports: { require: "./index.cjs" } })
    expect(Npm.packageEntry(tmp.path)).toBeUndefined()
  })
})

describe("Npm.add", () => {
  test.each(["interrupt", "timeout"] as const)(
    "bounded install handles %s during a stalled real registry request",
    async (mode) => {
      await using tmp = await tmpdir()
      const received = Promise.withResolvers<void>()
      const requests: string[] = []
      const server = createServer((request, response) => {
        requests.push(request.url ?? "")
        received.resolve()
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Registry did not listen")
      const cache = path.join(tmp.path, "cache")
      const spec = "stall-sdk@1.0.0"
      await fs.mkdir(path.join(cache, "packages", Npm.sanitize(spec)), { recursive: true })
      await writePackage(path.join(cache, "packages", Npm.sanitize(spec)), { name: "registry-fixture" })
      await Bun.write(
        path.join(cache, "packages", Npm.sanitize(spec), ".npmrc"),
        `registry=http://127.0.0.1:${address.port}\nfetch-retries=4\nfetch-timeout=70000\n`,
      )
      try {
        await Effect.gen(function* () {
          const npm = yield* Npm.Service
          const fiber = yield* npm.add(spec, { timeout: mode === "interrupt" ? 5_000 : 100 }).pipe(Effect.forkChild)
          yield* Effect.promise(() => deadline(received.promise, "registry request"))
          if (mode === "interrupt") {
            yield* Fiber.interrupt(fiber)
            return
          }
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("2 seconds"))
          expect(Exit.isFailure(exit)).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)
        expect(requests).toEqual(["/stall-sdk"])
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
    10_000,
  )

  test("reifies when package cache directory exists without the package installed", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "fixture-provider"))
    await writePackage(path.join(tmp.path, "fixture-provider"), {
      name: "fixture-provider",
      main: "index.js",
    })
    await Bun.write(path.join(tmp.path, "fixture-provider", "index.js"), "export const fixture = true\n")

    const spec = `fixture-provider@file:${path.join(tmp.path, "fixture-provider")}`
    await fs.mkdir(path.join(tmp.path, "cache", "packages", Npm.sanitize(spec)), { recursive: true })

    const entry = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(spec)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)

    expect(entry.entrypoint).toBeDefined()
  })
})

describe("Npm.install", () => {
  test("respects omit from project .npmrc", async () => {
    await using tmp = await tmpdir()

    await writePackage(tmp.path, {
      name: "fixture",
      dependencies: {
        "prod-pkg": "file:./prod-pkg",
      },
      devDependencies: {
        "dev-pkg": "file:./dev-pkg",
      },
    })
    await Bun.write(path.join(tmp.path, ".npmrc"), "omit=dev\n")
    await fs.mkdir(path.join(tmp.path, "prod-pkg"))
    await fs.mkdir(path.join(tmp.path, "dev-pkg"))
    await writePackage(path.join(tmp.path, "prod-pkg"), { name: "prod-pkg" })
    await writePackage(path.join(tmp.path, "dev-pkg"), { name: "dev-pkg" })

    await Npm.install(tmp.path)

    await expect(fs.stat(path.join(tmp.path, "node_modules", "prod-pkg"))).resolves.toBeDefined()
    await expect(fs.stat(path.join(tmp.path, "node_modules", "dev-pkg"))).rejects.toThrow()
  })
})

describe("Npm.addAs under Vector Local", () => {
  afterEach(async () => {
    Egress.configure(LocalPolicy.OFF)
    await Egress.erase()
  })
  const local = (block: ConfigLocalV1.Info = {}) =>
    Egress.configure(LocalPolicy.resolve({ global: { enabled: true, ...block } }))
  const allow = (hosts?: string[]) => ({
    source: "npm-plugins",
    reason: "Plugins",
    added_at: 1,
    added_by: "app" as const,
    ...(hosts ? { hosts } : {}),
  })
  // A registry on this computer that answers nothing, so an install that starts is seen and fails.
  const registry = async () => {
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? "")
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Registry did not listen")
    return {
      requests,
      url: `http://127.0.0.1:${address.port}/`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }
  const npmrc = async (cache: string, spec: string, text: string) => {
    await fs.mkdir(path.join(cache, "packages", Npm.sanitize(spec)), { recursive: true })
    await Bun.write(path.join(cache, "packages", Npm.sanitize(spec), ".npmrc"), text)
  }
  const addAs = (cache: string, spec: string) =>
    Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.addAs("npm-plugins", spec)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromiseExit)
  const refusal = (exit: Exit.Exit<unknown, unknown>) => {
    if (Exit.isSuccess(exit)) return undefined
    const error = Cause.squash(exit.cause) as { cause?: unknown }
    return error.cause instanceof Error ? error.cause.message : String(error)
  }

  test("loads a copy installed earlier as it is, deciding nothing", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const installed = path.join(cache, "packages", "cached-plugin@1.0.0", "node_modules", "cached-plugin")
    await fs.mkdir(installed, { recursive: true })
    await writePackage(installed, { name: "cached-plugin", main: "index.js" })
    await Bun.write(path.join(installed, "index.js"), "export {}\n")
    local()
    const exit = await addAs(cache, "cached-plugin@1.0.0")
    expect(Exit.isSuccess(exit) && exit.value.entrypoint).toBeTruthy()
    expect(Egress.events()).toEqual([])
  })

  test("starts no installer and no git for a package from a host Vector Local does not allow", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const fake = await registry()
    try {
      // The registry the npm config names is allowed, but the package's own address is on GitHub.
      const spec = "acme@github:vector/acme"
      await npmrc(cache, spec, `registry=${fake.url}\n`)
      local({ allow: [allow([new URL(fake.url).hostname])] })
      expect(refusal(await addAs(cache, spec))).toBe(
        `Vector Local did not install ${spec}. Vector asks before it downloads this, once.`,
      )
      expect(fake.requests).toEqual([])
      expect(Egress.events().map((event) => [event.origin, event.decision])).toEqual([
        [new URL(fake.url).origin, "allow"],
        ["https://github.com", "ask"],
      ])
    } finally {
      await fake.close()
    }
  })

  test("decides a registry package against the registry the npm config names, and Web access None first", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const spec = "corp-plugin@1.0.0"
    await npmrc(cache, spec, "registry=https://npm.corp.example.com/\n")
    local()
    expect(refusal(await addAs(cache, spec))).toBe(
      `Vector Local did not install ${spec}. Vector asks before it downloads this, once.`,
    )
    expect(Egress.events().map((event) => [event.source, event.origin])).toEqual([
      ["npm-plugins", "https://npm.corp.example.com"],
    ])
    local({ web: "none", allow: [allow()] })
    expect(refusal(await addAs(cache, spec))).toBe(
      `Vector Local did not install ${spec}. Web access is set to None, so Vector downloads nothing.`,
    )
  })

  test("installs from an allowed registry within its grant", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const fake = await registry()
    try {
      const spec = "allowed-plugin@1.0.0"
      await npmrc(cache, spec, `registry=${fake.url}\nfetch-retries=0\n`)
      // A registry on this computer is one Vector Local lets a download reach.
      local()
      const exit = await addAs(cache, spec)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(refusal(exit)).not.toContain("Vector Local did not install")
      expect(fake.requests).toEqual(["/allowed-plugin"])
    } finally {
      await fake.close()
    }
  })

  test("which uses a server installed earlier, and installs a missing one only when allowed", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const bin = path.join(cache, "packages", "lang-server", "node_modules", ".bin")
    await fs.mkdir(bin, { recursive: true })
    await Bun.write(path.join(bin, "lang-server"), "#!/bin/sh\n")
    local()
    const which = (pkg: string) =>
      Effect.gen(function* () {
        const npm = yield* Npm.Service
        return yield* npm.whichAs("lsp-install", pkg)
      }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)
    expect(await which("lang-server")).toBe(path.join(bin, "lang-server"))
    await npmrc(cache, "missing-server", "registry=https://registry.npmjs.org/\n")
    expect(await which("missing-server")).toBeUndefined()
    expect(Egress.events().map((event) => [event.source, event.decision])).toEqual([["lsp-install", "ask"]])
  })
})
