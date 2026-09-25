import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { Effect, Layer, Schema, Context } from "effect"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@vectordevai/core/process"
import { makeRuntime } from "@vectordevai/core/effect/runtime"
import semver from "semver"
import { NpmConfig } from "@vectordevai/core/npm-config"
import { InstallationChannel, InstallationVersion } from "@vectordevai/core/installation/version"
import { InstallationEvent } from "@vectordevai/schema/installation-event"
import type { InstallationOwnership } from "./ownership"
import type { Standalone } from "./standalone"

export type Method = InstallationOwnership.Method
export type UpgradeResult = Standalone.Result

export type ReleaseType = "patch" | "minor" | "major"

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `vector/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

const NpmPackage = Schema.Struct({ version: Schema.String })

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly ownership: () => Effect.Effect<InstallationOwnership.Owner>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<UpgradeResult, UpgradeFailedError>
  readonly uninstall: (method: Method) => Effect.Effect<UpgradeResult, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Installation") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const run = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.catch((err) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(err) })),
    )

    const execute: Standalone.Run = (command) => Effect.runPromise(run(command))
    const ownership = () =>
      Effect.tryPromise(async () => {
        const { InstallationOwnership } = await import("./ownership")
        return await InstallationOwnership.detect(execute)
      }).pipe(Effect.catch(() => Effect.succeed({ method: "unknown" } as const)))
    const result: Interface = {
      ownership,
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: () => ownership().pipe(Effect.map((owner) => owner.method)),
      latest: Effect.fn("Installation.latest")(function* (installMethod?: Method) {
        const owner = yield* ownership()
        const method = installMethod ?? owner.method
        if (method === "unknown") return InstallationVersion
        if (method === "standalone" && owner.method === "standalone") {
          const { Standalone } = yield* Effect.promise(() => import("./standalone"))
          return yield* Effect.tryPromise(() => Standalone.latest(owner.receipt))
        }
        if (method === "homebrew" || method === "scoop") {
          if (owner.method !== method)
            return yield* Effect.die(new Error("The running executable does not belong to this package manager."))
          return owner.latest
        }
        if (method === "standalone")
          return yield* Effect.die(new Error("The running executable has no valid standalone receipt."))
        const registry = yield* NpmConfig.registry(process.cwd())
        const channel = ["local", "dev"].includes(InstallationChannel) ? "latest" : InstallationChannel
        const response = yield* httpOk.execute(
          HttpClientRequest.get(`${registry}/@vectordevai%2fcli/${channel}`).pipe(HttpClientRequest.acceptJson),
        )
        const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response)
        return data.version
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        if (m === "unknown") {
          return yield* new UpgradeFailedError({
            stderr:
              "Vector could not verify this executable's installation channel. Reinstall through its original standalone installer or package manager.",
          })
        }
        if (!semver.valid(target)) {
          return yield* new UpgradeFailedError({ stderr: `Invalid Vector version: ${target}` })
        }
        const owner = yield* ownership()
        if (owner.method !== "unknown" && owner.method !== m)
          return yield* new UpgradeFailedError({
            stderr: `This executable is owned by ${owner.method}; use that channel to upgrade it.`,
          })
        if (m === "standalone") {
          if (owner.method !== "standalone")
            return yield* new UpgradeFailedError({
              stderr: "No valid standalone receipt was found for this executable.",
            })
          const { Standalone } = yield* Effect.promise(() => import("./standalone"))
          return yield* Effect.tryPromise({
            try: () => Standalone.upgrade(owner.receipt, target, execute),
            catch: (error) => new UpgradeFailedError({ stderr: errorMessage(error) }),
          })
        }
        if (m === "homebrew" || m === "scoop") {
          if (owner.method !== m)
            return yield* new UpgradeFailedError({
              stderr: "The selected package manager does not own this executable.",
            })
          if (target !== owner.latest)
            return yield* new UpgradeFailedError({
              stderr: `This package-manager channel currently provides ${owner.latest}. Use the manager's version selection tools for another version.`,
            })
          const upgraded = yield* run(
            m === "homebrew" ? ["brew", "upgrade", owner.package] : ["scoop", "update", owner.package],
          )
          if (upgraded.code !== 0)
            return yield* new UpgradeFailedError({ stderr: `Upgrade failed for ${m} (exit code ${upgraded.code}).` })
          return { status: "complete" as const }
        }
        const upgradeResult = yield* run([m, "install", "-g", `@vectordevai/cli@${target}`])
        if (upgradeResult.code !== 0) {
          return yield* new UpgradeFailedError({ stderr: `Upgrade failed for ${m} (exit code ${upgradeResult.code}).` })
        }
        yield* Effect.logInfo("upgraded", { method: m, target })
        return { status: "complete" as const }
      }),
      uninstall: Effect.fn("Installation.uninstall")(function* (method: Method) {
        const owner = yield* ownership()
        if (owner.method === "unknown" || owner.method !== method)
          return yield* new UpgradeFailedError({
            stderr:
              "Vector could not verify the executable's owner; remove it through its original installation channel.",
          })
        if (owner.method === "standalone") {
          const { Standalone } = yield* Effect.promise(() => import("./standalone"))
          return yield* Effect.tryPromise({
            try: () => Standalone.uninstall(owner.receipt, execute),
            catch: (error) => new UpgradeFailedError({ stderr: errorMessage(error) }),
          })
        }
        const command =
          owner.method === "homebrew"
            ? ["brew", "uninstall", owner.package]
            : owner.method === "scoop"
              ? ["scoop", "uninstall", owner.package]
              : [owner.method, owner.method === "bun" ? "remove" : "uninstall", "-g", "@vectordevai/cli"]
        const removed = yield* run(command)
        if (removed.code !== 0)
          return yield* new UpgradeFailedError({
            stderr: `Uninstall failed for ${owner.method} (exit code ${removed.code}).`,
          })
        return { status: "complete" as const }
      }),
    }

    return Service.of(result)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [httpClient, AppProcess.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const ownership = () => runPromise((s) => s.ownership())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))
export const uninstall = (...args: Parameters<Interface["uninstall"]>) => runPromise((s) => s.uninstall(...args))

export * as Installation from "."
