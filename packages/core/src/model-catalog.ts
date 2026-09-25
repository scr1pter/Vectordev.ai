import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ModelCatalog } from "@vectordevai/schema/model-catalog"
import { Global } from "./global"
import { Flag } from "./flag/flag"
import { Flock } from "./util/flock"
import { Hash } from "./util/hash"
import { FSUtil } from "./fs-util"
import { InstallationChannel, InstallationVersion } from "./installation/version"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"

const USER_AGENT = `vector/${InstallationVersion} (${InstallationChannel}; ${Flag.VECTOR_CLIENT})`

export const CatalogModelStatus = ModelCatalog.CatalogModelStatus
export type CatalogModelStatus = ModelCatalog.CatalogModelStatus
export const Model = ModelCatalog.Model
export type Model = ModelCatalog.Model
export const Provider = ModelCatalog.Provider
export type Provider = ModelCatalog.Provider

export const Event = ModelCatalog.Event

declare const VECTOR_MODEL_CATALOG: Record<string, Provider> | undefined

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ModelCatalog") {}

export const DEFAULT_MIRROR = "https://vectordev.ai/models"

export function mirrorURL(value: string | undefined) {
  const url = URL.parse(value || DEFAULT_MIRROR)
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    return undefined
  return url.href.replace(/\/$/, "").replace(/\/api\.json$/, "")
}

export function ownedMirror(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.port) return false
  const releasePath = /^\/releases\/vector-v\d+\.\d+\.\d+\/?$/.test(url.pathname)
  const owned = url.hostname === "vectordev.ai" && url.pathname === "/models"
  const release = url.hostname === "42qryducihx01gl0.public.blob.vercel-storage.com" && releasePath
  return owned || release
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2.Service
    const http = HttpClient.filterStatusOk(
      (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: "errors-and-responses",
          times: 2,
          schedule: Schedule.exponential(200).pipe(Schedule.jittered),
        }),
      ),
    )

    // The bundled snapshot keeps startup usable while the owned mirror is unavailable.
    const source = mirrorURL(Flag.VECTOR_MODELS_URL)
    if (Flag.VECTOR_MODELS_URL && !source)
      yield* Effect.logWarning("Invalid VECTOR_MODELS_URL; using local or bundled catalog data without refresh")
    if (source && !ownedMirror(source))
      yield* Effect.logWarning(
        "Using an operator-supplied model catalog mirror. Its models and prices are not maintained by Vector; only bundled SDKs are accepted.",
        { origin: new URL(source).origin, encrypted: source.startsWith("https:") },
      )
    const filepath = path.join(Global.Path.cache, source ? `models-${Hash.fast(source)}.json` : "models-bundled.json")
    const ttl = Duration.minutes(5)
    const lockKey = `model-catalog:${filepath}`

    const fresh = Effect.fnUntraced(function* () {
      const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return false
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      return Date.now() - mtime < Duration.toMillis(ttl)
    })

    const fetchApi = Effect.fn("ModelCatalog.fetchApi")(function* () {
      return yield* HttpClientRequest.get(`${source}/api.json`).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
        http.execute,
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )
    })

    const loadFromDisk = fs.readJson(Flag.VECTOR_MODELS_PATH ?? filepath).pipe(
      Effect.flatMap((value) => Effect.try({ try: () => ModelCatalog.decodeCatalog(value), catch: (cause) => cause })),
      Effect.catch(() => {
        if (Flag.VECTOR_MODELS_PATH === undefined) {
          return fs.remove(filepath, { force: true }).pipe(Effect.ignore, Effect.as(undefined))
        }
        return Effect.succeed(undefined)
      }),
    )

    const loadSnapshot = Effect.sync(() =>
      typeof VECTOR_MODEL_CATALOG === "undefined" ? undefined : ModelCatalog.decodeCatalog(VECTOR_MODEL_CATALOG),
    )

    const fetchAndWrite = Effect.fn("ModelCatalog.fetchAndWrite")(function* () {
      const response = yield* fetchApi()
      const catalog = yield* Effect.try({
        try: () => ModelCatalog.decodeCatalog(JSON.parse(response)),
        catch: (cause) => cause,
      })
      const text = JSON.stringify(catalog)
      const tempfile = `${filepath}.${process.pid}.${Date.now()}.tmp`
      yield* fs.writeWithDirs(tempfile, text).pipe(
        Effect.andThen(fs.rename(tempfile, filepath)),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* fs.remove(tempfile, { force: true }).pipe(Effect.ignore)
            return yield* Effect.fail(error)
          }),
        ),
      )
      return catalog
    })

    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return fromDisk
      const snapshot = yield* loadSnapshot
      if (snapshot) return snapshot
      if (!source || Flag.VECTOR_MODELS_PATH || Flag.VECTOR_DISABLE_MODELS_FETCH) return {}
      // Flock is cross-process: concurrent Vector CLIs can race on this cache file.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          return yield* fetchAndWrite()
        }),
      )
    }).pipe(Effect.withSpan("ModelCatalog.populate"), Effect.orDie)

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

    const get = (): Effect.Effect<Record<string, Provider>> => cachedGet

    const refresh = Effect.fn("ModelCatalog.refresh")(function* (force = false) {
      if (!source || Flag.VECTOR_MODELS_PATH || Flag.VECTOR_DISABLE_MODELS_FETCH) return
      if (!force && (yield* fresh())) return
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          // Re-check under the lock: another process may have refreshed between
          // our outer check and lock acquisition.
          if (!force && (yield* fresh())) return
          yield* fetchAndWrite()
          yield* invalidate
          yield* events.publish(Event.Refreshed, {})
        }),
      ).pipe(
        Effect.tapCause((cause) => Effect.logError("Failed to refresh the Vector model catalog", { cause: cause })),
        Effect.ignore,
      )
    })

    if (
      source &&
      !Flag.VECTOR_MODELS_PATH &&
      !Flag.VECTOR_DISABLE_MODELS_FETCH &&
      !process.argv.includes("--get-yargs-completions")
    ) {
      // Schedule.spaced runs the effect once, then waits between completions.
      yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced("60 minutes")), Effect.ignore))
    }

    return Service.of({ get, refresh })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [FSUtil.node, EventV2.node, httpClient] })

export * as ModelCatalog from "./model-catalog"
