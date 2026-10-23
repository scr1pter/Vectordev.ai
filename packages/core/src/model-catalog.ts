import path from "path"
import { Context, Deferred, Duration, Effect, Layer, Option, Ref, Schedule, Schema } from "effect"
import type { FileSystem } from "effect"
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
import { Egress } from "./local-mode/egress"
import { EgressHttpClient } from "./local-mode/http-client"
import { LocalPolicy } from "./local-mode/policy"
import { LocalSources } from "./local-mode/sources"

const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)

const USER_AGENT = `vector/${InstallationVersion} (${InstallationChannel}; ${Flag.VECTOR_CLIENT})`

export const CatalogModelStatus = ModelCatalog.CatalogModelStatus
export type CatalogModelStatus = ModelCatalog.CatalogModelStatus
export const Model = ModelCatalog.Model
export type Model = ModelCatalog.Model
export const Provider = ModelCatalog.Provider
export type Provider = ModelCatalog.Provider

export const Event = ModelCatalog.Event
export const modeSupported = ModelCatalog.modeSupported

declare const VECTOR_MODEL_CATALOG: Record<string, Provider> | undefined

/**
 * The catalog this build carries, undefined in a build without one. The build substitutes an object literal for the
 * name, so this is the only place that names it: one copy in the bundle, allocated only when something asks for it.
 */
export function bundled() {
  return typeof VECTOR_MODEL_CATALOG === "undefined" ? undefined : VECTOR_MODEL_CATALOG
}

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ModelCatalog") {}

export const DEFAULT_MIRROR = "https://vectordev.ai/models"

// Vector Local blocks the catalog's refresh unless the user allowed it or the mirror is on this computer, so nothing is
// sent. The cached and bundled catalogs still load.
const LOCAL_SOURCE = LocalSources.get("model-catalog")!
const offline = (mirror: string) =>
  LocalPolicy.decide(Egress.policy(), { purpose: LOCAL_SOURCE.purpose, url: mirror, source: LOCAL_SOURCE.id })
    .decision !== "allow"

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
      EgressHttpClient.make(yield* HttpClient.HttpClient).pipe(
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

    // A missing mirror stays missing for the whole session: warn once, then stay quiet until a fetch succeeds.
    const unavailable = yield* Ref.make(false)
    const reportUnavailable = (cause: unknown) =>
      Ref.getAndSet(unavailable, true).pipe(
        Effect.flatMap((reported) =>
          reported
            ? Effect.logDebug("The Vector model catalog is still unavailable", { cause: cause })
            : Effect.logWarning(
                "The Vector model catalog is unavailable; configured providers keep working without catalog models",
                { cause: cause },
              ),
        ),
      )

    // A mirror written by a later release may name SDKs this build lacks; skip those entries, keep the rest,
    // and name each skipped entry once rather than on every hourly refresh.
    const skipped = new Set<string>()
    const decode = (value: unknown) =>
      Effect.gen(function* () {
        const omitted: string[] = []
        const catalog = yield* Effect.try({
          try: () => ModelCatalog.decodeCatalog(value, (entry) => omitted.push(entry)),
          catch: (cause) => cause,
        })
        const unseen = omitted.filter((entry) => !skipped.has(entry))
        unseen.forEach((entry) => skipped.add(entry))
        yield* Effect.forEach(unseen, (entry) => Effect.logWarning(`Skipping model catalog entry: ${entry}`), {
          discard: true,
        })
        return catalog
      })

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
        EgressHttpClient.labelled(LOCAL_SOURCE.id),
      )
    })

    // Whether any get() has started loading the catalog, and the cache file as it was when the cached catalog was
    // decoded from it: together they tell a refresh whether the catalog it would load is the one already loaded, or
    // the one about to be.
    const loadStarted = yield* Ref.make(false)
    const firstLoad = yield* Deferred.make<void>()
    const decodedFrom = yield* Ref.make<string | undefined>(undefined)
    const identity = (info: FileSystem.File.Info) =>
      `${Option.getOrElse(info.mtime, () => new Date(0)).getTime()}:${info.size}`

    const loadFromDisk = Effect.gen(function* () {
      // Taken before the read, so a file replaced in between no longer matches when a refresh checks it.
      const info = yield* fs.stat(Flag.VECTOR_MODELS_PATH ?? filepath)
      const catalog = yield* fs.readJson(Flag.VECTOR_MODELS_PATH ?? filepath).pipe(Effect.flatMap(decode))
      if (Flag.VECTOR_MODELS_PATH !== undefined) return catalog
      // Every entry of the cached mirror text is one this build skips. Report it here, because a refresh that found the
      // mirror unchanged before this load never decoded the text. Left unrecorded, so the next refresh takes the full
      // path, which fails the same way without a second warning.
      if (!Object.keys(catalog).length) {
        yield* reportUnavailable(new Error("The model catalog mirror has no usable providers"))
        return catalog
      }
      yield* Ref.set(decodedFrom, identity(info))
      return catalog
    }).pipe(
      Effect.catch(() => {
        if (Flag.VECTOR_MODELS_PATH === undefined) {
          return fs.remove(filepath, { force: true }).pipe(Effect.ignore, Effect.as(undefined))
        }
        return Effect.succeed(undefined)
      }),
    )

    // Allocate the bundled catalog only when disk data is unavailable.
    const loadSnapshot = Effect.suspend(() => {
      const snapshot = bundled()
      return snapshot === undefined ? Effect.succeed(undefined) : decode(snapshot)
    })

    const store = Effect.fn("ModelCatalog.store")(function* (response: string) {
      const catalog = yield* decodeJson(response).pipe(Effect.flatMap(decode))
      // Never replace a usable cache with a mirror whose every provider was skipped or refused.
      if (!Object.keys(catalog).length)
        return yield* Effect.fail(new Error("The model catalog mirror has no usable providers"))
      yield* Ref.set(unavailable, false)
      // Every installed build shares this cache file and filters it again on read, so save the validated mirror
      // text rather than this build's filtered view: a newer build must still see the providers this one skipped.
      const tempfile = `${filepath}.${process.pid}.${Date.now()}.tmp`
      // Saving is best-effort: a read-only or full cache directory must not discard a catalog that already loaded.
      yield* fs.writeWithDirs(tempfile, response).pipe(
        Effect.andThen(fs.rename(tempfile, filepath)),
        Effect.catch((error) =>
          fs
            .remove(tempfile, { force: true })
            .pipe(
              Effect.ignore,
              Effect.andThen(Effect.logWarning("Could not save the Vector model catalog cache", { cause: error })),
            ),
        ),
      )
      return catalog
    })

    // The mirror still serves the text in the cache file, and the cached catalog was decoded from that file as it still
    // is, or nothing has loaded the catalog yet and the first get() will read that file: renew the file's age and keep
    // the rest. Decoding, rewriting and reloading the same text gives the same catalog, at the cost of one or two more
    // decodes and a rebuild of every catalog model, on most starts. Callers hold the catalog lock.
    const unchanged = Effect.fnUntraced(function* (response: string) {
      const decoded = yield* Ref.get(decodedFrom)
      if (!decoded && (yield* Ref.get(loadStarted))) return false
      const info = yield* fs.stat(filepath).pipe(Effect.option)
      if (Option.isNone(info) || (decoded && identity(info.value) !== decoded)) return false
      const text = yield* fs.readFileString(filepath).pipe(Effect.option)
      if (Option.isNone(text) || text.value !== response) return false
      const now = new Date()
      const touched = yield* fs.utimes(filepath, now, now).pipe(Effect.andThen(fs.stat(filepath)), Effect.option)
      if (Option.isNone(touched)) return false
      if (decoded) yield* Ref.set(decodedFrom, identity(touched.value))
      yield* Ref.set(unavailable, false)
      return true
    })

    const populate = Effect.gen(function* () {
      yield* Ref.set(loadStarted, true)
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return fromDisk
      const snapshot = yield* loadSnapshot
      if (snapshot) return snapshot
      if (!source || Flag.VECTOR_MODELS_PATH || Flag.VECTOR_DISABLE_MODELS_FETCH || offline(source)) return {}
      // Flock is cross-process: concurrent Vector CLIs can race on this cache file.
      // A failed fetch degrades to an empty catalog so configured and custom providers still resolve.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          return yield* store(yield* fetchApi())
        }),
      ).pipe(Effect.catch((error) => reportUnavailable(error).pipe(Effect.as({}))))
    }).pipe(
      Effect.ensuring(Deferred.succeed(firstLoad, undefined)),
      Effect.withSpan("ModelCatalog.populate"),
      Effect.orDie,
    )

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

    // Mask cache publication too: protecting only the loader lets its pending interruption become the cached exit.
    const get = (): Effect.Effect<Record<string, Provider>> => Effect.uninterruptible(cachedGet)

    const refresh = Effect.fn("ModelCatalog.refresh")(function* (force = false) {
      if (!source || Flag.VECTOR_MODELS_PATH || Flag.VECTOR_DISABLE_MODELS_FETCH || offline(source)) return
      if (!force && (yield* fresh())) return
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          // Re-check under the lock: another process may have refreshed between
          // our outer check and lock acquisition.
          if (!force && (yield* fresh())) return
          const response = yield* fetchApi()
          if (yield* unchanged(response)) return
          yield* store(response)
          // The next get() decodes the new file and records it.
          yield* Ref.set(decodedFrom, undefined)
          yield* invalidate
          yield* events.publish(Event.Refreshed, {})
        }),
      ).pipe(Effect.catch(reportUnavailable))
    })

    if (
      source &&
      !Flag.VECTOR_MODELS_PATH &&
      !Flag.VECTOR_DISABLE_MODELS_FETCH &&
      !process.argv.includes("--get-yargs-completions")
    ) {
      // The first refresh waits for the first load, or ten seconds in a process that does not load the catalog, so it
      // compares with the catalog that load decoded instead of racing it. Racing it cost a stale-cache start two more
      // decodes of the whole catalog and a rebuild of every catalog model, though the mirror rarely changes.
      // Schedule.spaced runs the effect once, then waits between completions.
      yield* Effect.forkScoped(
        Effect.raceFirst(Deferred.await(firstLoad), Effect.sleep("10 seconds")).pipe(
          Effect.andThen(refresh().pipe(Effect.repeat(Schedule.spaced("60 minutes")))),
          Effect.ignore,
        ),
      )
    }

    return Service.of({ get, refresh })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [FSUtil.node, EventV2.node, httpClient] })

export * as ModelCatalog from "./model-catalog"
