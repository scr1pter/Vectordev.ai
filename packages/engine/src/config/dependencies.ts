export * as ConfigDependencies from "./dependencies"

import path from "node:path"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { Clock, Context, Effect, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { Npm } from "@vectordevai/core/npm"
import { PluginDependencyVersion } from "./plugin-version"

export const packageName = "@vectordevai/plugin"
export const specifier = `${packageName}@${PluginDependencyVersion}`
export const timeout = 5_000
const retryDelay = 15 * 60_000

export function directory(cache = Global.Path.cache) {
  return path.join(cache, "packages", Npm.sanitize(specifier), "node_modules", packageName)
}

export function readyFile(cache = Global.Path.cache) {
  return path.join(cache, "plugin-sdk", PluginDependencyVersion, "ready")
}

export interface Interface {
  readonly prepare: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ConfigDependencies") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const npm = yield* Npm.Service
    const afs = yield* FSUtil.Service
    const global = yield* Global.Service
    const prepare = yield* Effect.cached(
      Effect.gen(function* () {
        if (
          (yield* afs.existsSafe(readyFile(global.cache))) &&
          (yield* afs.existsSafe(path.join(directory(global.cache), "package.json")))
        )
          return
        const marker = path.join(global.cache, "plugin-sdk", PluginDependencyVersion, "retry-after")
        const now = yield* Clock.currentTimeMillis
        const retry = Number(yield* afs.readFileStringSafe(marker))
        if (retry > now) return
        // Persist the cooldown before starting so repeated offline launches do not retry immediately.
        yield* afs.writeWithDirs(marker, String(now + retryDelay))
        // A timed-out reify may leave a partial package directory. Only a completed install is reusable.
        yield* npm.add(specifier, { timeout, force: true }).pipe(Effect.timeout(timeout))
        yield* afs.writeWithDirs(readyFile(global.cache), specifier)
        yield* afs.remove(marker, { force: true })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Plugin SDK setup is unavailable; after restoring registry access, restart Vector once the 15-minute retry cooldown has elapsed",
            {
              package: specifier,
              error: String(cause),
            },
          ),
        ),
      ),
    )
    return Service.of({ prepare: () => prepare })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Npm.node, FSUtil.node, Global.node] })

// Resolve only an already-cached SDK. Importing a local plugin must never wait for a registry request.
export async function link(entry: string, cache = Global.Path.cache) {
  const target = directory(cache)
  if (!(await fs.stat(readyFile(cache)).catch(() => undefined))) return false
  if (!(await fs.stat(path.join(target, "package.json")).catch(() => undefined))) return false
  const parent = path.dirname(entry.startsWith("file:") ? fileURLToPath(entry) : entry)
  const destination = path.join(parent, "node_modules", packageName)
  if (await fs.lstat(destination).catch(() => undefined)) return true
  // A project may deliberately pin a different SDK in an ancestor directory.
  const locations = createRequire(path.join(parent, "plugin.js")).resolve.paths(packageName) ?? []
  const existing = await Promise.all(
    locations.map((location) => fs.lstat(path.join(location, packageName)).catch(() => undefined)),
  )
  if (existing.some(Boolean)) return true
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.symlink(target, destination, process.platform === "win32" ? "junction" : "dir").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return
    throw error
  })
  return true
}
