export * as BrainEmbed from "./embed"

// @ts-ignore Bun's static file import is embedded by `bun build --compile`; some consumers also declare *.wasm.
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm" with { type: "file" }
import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Queue, Schema, Scope, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { Global } from "../global"
import { BrainEmbedManifest } from "./embed-manifest"
import golden from "./embed-golden.json"
import { BrainLexical } from "./lexical"
import type { BrainSchema } from "./schema"
import { BrainVector } from "./vector"
import { BrainWorker } from "./worker/host"

// The local search model: downloaded once when the user asks, checked, and from then on run on this computer with no
// network at all.
//
// - Files come from Vector's own copy (a GitHub release) and then from Hugging Face at the pinned revision. A
//   redirect is followed only to the hosts of the source it came from. Each file streams to `<file>.part`, resumes
//   with an HTTP range after a cut, stops once it grows past its pinned size, and is renamed into place only when its
//   sha256 is the pinned one. manifest.json is written last, so a folder without one holds no model.
// - At first use in each process every file's size and sha256 are checked again. Every load in the background reader
//   embeds three canary sentences, compared with the vectors the pinned model gave them (embed-golden.json); a model
//   that gives other vectors on this computer is not used, and Settings offers the full-precision graph instead.
// - Models live in `<data>/models/embedding`, outside the brain's folder, so erasing all memory keeps the download.
// - A request's query is embedded only by a model already loaded, within 300 ms, or not at all: search then uses
//   keywords and code links, and the model loads in the background for the next request.

export class EmbedError extends Schema.TaggedErrorClass<EmbedError>()("BrainEmbed.EmbedError", {
  /**
   * off: downloads are turned off here; busy: a download is already running; network: no source gave the file;
   * host: a redirect led to a host the source does not use; size, verify: a file was not its pinned size or sha256;
   * missing: a folder to install from lacks a file; check: the model gave other vectors than its pinned ones here.
   */
  reason: Schema.Literals(["off", "busy", "network", "host", "size", "verify", "missing", "check"]),
  message: Schema.String,
}) {}

/** Which model, and which of its graphs. */
export type Choice = { readonly model?: BrainEmbedManifest.ModelID; readonly variant?: BrainEmbedManifest.Variant }

/** The model in use, as storage and the gate need it. */
export type Current = {
  /** What vectors are stored under (BrainEmbedManifest.key). */
  readonly key: string
  readonly floor: number
  readonly dims: number
  /** The user holds embedding in the background. */
  readonly paused: boolean
}

export interface Interface {
  readonly status: () => Effect.Effect<BrainSchema.ModelStatus>
  /** Download a model and check it, waiting until it is ready. */
  readonly download: (choice?: Choice) => Effect.Effect<BrainSchema.ModelStatus, EmbedError>
  /** Start a download in the background and say how it stands; `status` follows it. */
  readonly start: (choice?: Choice) => Effect.Effect<BrainSchema.ModelStatus>
  /** Copy a model's files from a folder (for a computer with no network), checked as a download is. */
  readonly install: (from: string, choice?: Choice) => Effect.Effect<BrainSchema.ModelStatus, EmbedError>
  /** Delete every downloaded model. */
  readonly remove: () => Effect.Effect<BrainSchema.ModelStatus>
  /** Hold or resume embedding in the background; it holds until resumed, across restarts. */
  readonly pause: (paused: boolean) => Effect.Effect<BrainSchema.ModelStatus>
  /** The model in use when one is ready; undefined until then. */
  readonly current: () => Effect.Effect<Current | undefined>
  /** A request's vector: undefined when no model is ready, it is not loaded yet, or it takes over the timeout. */
  readonly query: (text: string) => Effect.Effect<Float32Array | undefined>
  /** Passages' vectors, in the background; undefined when no model is ready or it could not run. */
  readonly embed: (texts: readonly string[]) => Effect.Effect<readonly Float32Array[] | undefined>
  /** Load the model in the background, so the next request's query does not wait. */
  readonly warm: () => Effect.Effect<void>
  /** Load the model now and wait for it, as a one-off command does; false when there is none to use. */
  readonly prepare: () => Effect.Effect<boolean>
  /** Waits until a model is downloaded, removed, paused, resumed or fails. */
  readonly changed: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/BrainEmbed") {}

/** Where a model's files may come from: a URL per file, and the hosts its redirects may lead to. */
export type Source = {
  readonly name: "mirror" | "huggingface"
  readonly url: (model: BrainEmbedManifest.Model, file: BrainEmbedManifest.File) => string | undefined
  readonly hosts: readonly string[]
}

export type Canary = { readonly text: string; readonly role: "query" | "passage"; readonly vector: readonly number[] }
export type Golden = Readonly<
  Record<string, { readonly revision: string; readonly int8?: readonly Canary[]; readonly fp32?: readonly Canary[] }>
>

export type Options = {
  /** The models folder; `<data>/models/embedding` by default. */
  readonly dir?: string
  readonly sources?: readonly Source[]
  /** Models by id in place of the manifest's, as tests give the fixture model. */
  readonly models?: Partial<Record<BrainEmbedManifest.ModelID, BrainEmbedManifest.Model>>
  readonly golden?: Golden
  /** ONNX Runtime's wasm, in place of the copy this build ships. */
  readonly wasm?: string
  /** Whether downloads may start; off when VECTOR_BRAIN_EMBED=off, as in tests and CI. */
  readonly downloads?: boolean
  /** Milliseconds a request's query may take. */
  readonly timeout?: number
  /** Attempts per source and file. */
  readonly attempts?: number
}

/** The longest a request waits for its query vector. */
export const TIMEOUT = 300

export const SOURCES: readonly Source[] = [
  {
    name: "mirror",
    // Only files with a pinned sha256 are taken from the copy: it is trusted for nothing it cannot prove.
    url: (model, file) =>
      file.sha256 ? `${BrainEmbedManifest.MIRROR.base}${BrainEmbedManifest.asset(model, file)}` : undefined,
    hosts: BrainEmbedManifest.MIRROR.hosts,
  },
  { name: "huggingface", url: BrainEmbedManifest.huggingFace, hosts: BrainEmbedManifest.HUGGING_FACE.hosts },
]

/** The models folder inside Vector's data directory: beside the brain's folder, never in it. */
export function directory(data: string) {
  return path.join(data, "models", "embedding")
}

export const layerWith = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const worker = yield* BrainWorker.Service
      const http = yield* HttpClient.HttpClient
      const scope = yield* Effect.scope
      const changes = yield* Queue.sliding<void>(1)
      return make({ ...options, dir: options.dir ?? directory(global.data) }, { worker, http, scope, changes })
    }),
  )

export const layer = layerWith()

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node, BrainWorker.node, httpClient] })

/** No model, ever: search uses keywords and code links, as before this model existed. */
export const layerOff = Layer.succeed(
  Service,
  Service.of({
    status: () => Effect.succeed({ state: "absent", downloads: false }),
    download: () => Effect.fail(new EmbedError({ reason: "off", message: "Search by meaning is off here." })),
    start: () => Effect.succeed({ state: "absent", downloads: false }),
    install: () => Effect.fail(new EmbedError({ reason: "off", message: "Search by meaning is off here." })),
    remove: () => Effect.succeed({ state: "absent", downloads: false }),
    pause: () => Effect.succeed({ state: "absent", downloads: false }),
    current: () => Effect.succeed(undefined),
    query: () => Effect.succeed(undefined),
    embed: () => Effect.succeed(undefined),
    warm: () => Effect.void,
    prepare: () => Effect.succeed(false),
    changed: Effect.never,
  }),
)

/**
 * A stand-in model for tests and the eval: signed feature hashing of a text's terms and their character trigrams, so
 * words that share most of their letters land near each other. It is deterministic, needs no file, and knows nothing
 * of meaning beyond spelling; the real model is what finds paraphrases.
 */
export const layerHash = (options: { readonly dims?: number; readonly floor?: number; readonly key?: string } = {}) => {
  const dims = options.dims ?? 256
  const current: Current = { key: options.key ?? "hash", floor: options.floor ?? 0.25, dims, paused: false }
  return Layer.succeed(
    Service,
    Service.of({
      status: () => Effect.succeed({ state: "ready", model: "hash", variant: "int8" }),
      download: () => Effect.succeed({ state: "ready", model: "hash", variant: "int8" }),
      start: () => Effect.succeed({ state: "ready", model: "hash", variant: "int8" }),
      install: () => Effect.succeed({ state: "ready", model: "hash", variant: "int8" }),
      remove: () => Effect.succeed({ state: "ready", model: "hash", variant: "int8" }),
      pause: () => Effect.succeed({ state: "ready", model: "hash", variant: "int8" }),
      current: () => Effect.succeed(current),
      query: (text) => Effect.succeed(hashed(text, dims)),
      embed: (texts) => Effect.succeed(texts.map((text) => hashed(text, dims))),
      warm: () => Effect.void,
      prepare: () => Effect.succeed(true),
      changed: Effect.never,
    }),
  )
}

/** The hash embedder's vector for a text. */
export function hashed(text: string, dims = 256) {
  const vector = new Float32Array(dims)
  const add = (feature: string, weight: number) => {
    const hash = fnv(feature)
    vector[hash % dims]! += (hash & 0x80000000 ? -1 : 1) * weight
  }
  for (const term of BrainLexical.terms(text).keys()) {
    add(`w:${term}`, 1)
    const padded = `^${term}$`
    for (let at = 0; at + 3 <= padded.length; at++) add(`g:${padded.slice(at, at + 3)}`, 0.5)
  }
  return BrainVector.normalize(vector)
}

function fnv(text: string) {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at++) hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193) >>> 0
  return hash >>> 0
}

type Installed = {
  readonly id: BrainEmbedManifest.ModelID
  readonly revision: string
  readonly variants: readonly BrainEmbedManifest.Variant[]
  /** Each file's size and sha256 as checked when it was installed. */
  readonly files: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>
  readonly source: "mirror" | "huggingface" | "folder"
  readonly installedAt: number
}

type Settings = {
  readonly active?: { readonly model: BrainEmbedManifest.ModelID; readonly variant: BrainEmbedManifest.Variant }
  readonly paused?: boolean
}

type Phase =
  | { readonly type: "idle" }
  | {
      readonly type: "downloading" | "verifying"
      readonly model: BrainEmbedManifest.ModelID
      readonly variant: BrainEmbedManifest.Variant
      bytes: number
      readonly total: number
    }

type Chosen = {
  readonly model: BrainEmbedManifest.Model
  readonly variant: BrainEmbedManifest.Variant
  readonly installed: Installed
  readonly key: string
}

function make(
  options: Options & { readonly dir: string },
  deps: {
    readonly worker: BrainWorker.Interface
    readonly http: HttpClient.HttpClient
    readonly scope: Scope.Scope
    readonly changes: Queue.Queue<void>
  },
): Interface {
  const dir = options.dir
  const worker = deps.worker
  const http = deps.http
  const sources = options.sources ?? SOURCES
  const attempts = options.attempts ?? 3
  const timeout = options.timeout ?? TIMEOUT
  const downloads = options.downloads ?? process.env.VECTOR_BRAIN_EMBED !== "off"
  const goldens: Golden = options.golden ?? (golden as Golden)
  const models = { ...BrainEmbedManifest.MODELS, ...options.models } as Readonly<
    Record<BrainEmbedManifest.ModelID, BrainEmbedManifest.Model>
  >
  const state = {
    phase: { type: "idle" } as Phase,
    // What was found on disk, kept briefly: a query reads it on every request, and another process may install a model.
    disk: undefined as
      | { readonly at: number; readonly installed: readonly Installed[]; readonly settings: Settings }
      | undefined,
    // Models whose files were checked in this process, and why one may not be used here.
    verified: new Set<string>(),
    failures: new Map<string, { readonly message: string; readonly check: boolean }>(),
    ranked: new Set<string>(),
    warming: false,
    error: undefined as string | undefined,
  }

  const changed = () => Queue.offer(deps.changes, undefined).pipe(Effect.asVoid)

  const folder = (model: BrainEmbedManifest.Model) => path.join(dir, `${model.id}@${model.revision}`)

  // --- What is on disk ----------------------------------------------------------------------------------------------

  const disk = Effect.fnUntraced(function* (fresh = false) {
    if (!fresh && state.disk && Date.now() - state.disk.at < 5_000) return state.disk
    const installed = (yield* Effect.promise(() =>
      Promise.all(Object.values(models).map((model) => readInstalled(folder(model), model))),
    )).filter((item): item is Installed => item !== undefined)
    const settings = yield* Effect.promise(() => readJson<Settings>(path.join(dir, "settings.json")))
    state.disk = { at: Date.now(), installed, settings: settings ?? {} }
    return state.disk
  })

  // The model in use: the one last chosen if it is still there, else the default, else any.
  const chosen = Effect.fnUntraced(function* (fresh = false) {
    const found = yield* disk(fresh)
    const active = found.settings.active
    const pick =
      found.installed.find((item) => active && item.id === active.model && item.variants.includes(active.variant)) ??
      found.installed.find((item) => item.id === BrainEmbedManifest.DEFAULT) ??
      found.installed[0]
    if (!pick) return undefined
    const variant =
      active && pick.id === active.model && pick.variants.includes(active.variant)
        ? active.variant
        : pick.variants.includes("int8")
          ? "int8"
          : "fp32"
    const model = models[pick.id]
    return { model, variant, installed: pick, key: BrainEmbedManifest.key(model, variant) } satisfies Chosen
  })

  const writeSettings = (settings: Settings) =>
    Effect.promise(async () => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      await atomic(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2))
      state.disk = undefined
    })

  const offered = Effect.fnUntraced(function* () {
    const found = yield* disk()
    return Object.values(models).map(
      (model): BrainSchema.ModelOption => ({
        id: model.id,
        label: model.label,
        description: model.description,
        license: model.license,
        owner: model.owner,
        source: `https://huggingface.co/${model.repo}/tree/${model.revision}`,
        revision: model.revision,
        bytes: BrainEmbedManifest.size(model),
        ...(model.fallback ? { fallback: BrainEmbedManifest.size(model, "fp32") } : {}),
        sha256: model.files.model.sha256 ?? "",
        ...(model.preview ? { preview: model.preview } : {}),
        installed: found.installed.some((item) => item.id === model.id),
      }),
    )
  })

  const status = Effect.fn("BrainEmbed.status")(function* () {
    const found = yield* disk()
    const options = yield* offered()
    const reader = yield* worker.status()
    const common = {
      downloads,
      options,
      ...(found.settings.paused ? { paused: true } : {}),
      worker: { mode: reader.mode, ...(reader.reason ? { reason: reader.reason } : {}) },
    }
    const phase = state.phase
    if (phase.type !== "idle")
      return {
        state: phase.type,
        model: phase.model,
        variant: phase.variant,
        bytes: phase.bytes,
        total: phase.total,
        progress: phase.total > 0 ? Math.min(1, phase.bytes / phase.total) : 0,
        ...common,
      } satisfies BrainSchema.ModelStatus
    const current = yield* chosen()
    if (!current)
      return {
        state: "absent",
        ...(state.error ? { error: state.error } : {}),
        ...common,
      } satisfies BrainSchema.ModelStatus
    const failure = state.failures.get(current.key)
    const size = BrainEmbedManifest.size(current.model, current.variant)
    const check = reader.check?.key === current.key ? reader.check : undefined
    return {
      state: failure ? "failed" : "ready",
      model: current.model.id,
      variant: current.variant,
      bytes: size,
      total: size,
      source: current.installed.source,
      ...(failure ? { error: failure.message } : state.error ? { error: state.error } : {}),
      ...(failure?.check && current.variant === "int8" && current.model.fallback ? { fallback: true } : {}),
      ...(check
        ? {
            check: {
              lowest: Math.min(1, ...check.cosines),
              needed: thresholdOf(current),
              by: check.cosines.length > 0 ? ("vectors" as const) : ("ranking" as const),
            },
          }
        : {}),
      ...common,
    } satisfies BrainSchema.ModelStatus
  })

  // --- Downloading --------------------------------------------------------------------------------------------------

  const download = Effect.fn("BrainEmbed.download")(function* (choice: Choice = {}) {
    if (!downloads)
      return yield* new EmbedError({
        reason: "off",
        message: "Downloads are turned off here (VECTOR_BRAIN_EMBED=off). Install the model from a folder instead.",
      })
    if (state.phase.type !== "idle")
      return yield* new EmbedError({ reason: "busy", message: "The search model is already downloading." })
    const model = models[choice.model ?? BrainEmbedManifest.DEFAULT]
    const variant = choice.variant ?? "int8"
    const files = BrainEmbedManifest.files(model, variant)
    const phase = {
      type: "downloading" as const,
      model: model.id,
      variant,
      bytes: 0,
      total: files.reduce((total, file) => total + file.bytes, 0),
    }
    state.phase = phase
    state.error = undefined
    yield* Effect.gen(function* () {
      yield* Effect.promise(() => ensureFolder(folder(model)))
      const fetched: {
        readonly name: string
        readonly bytes: number
        readonly sha256: string
        readonly source?: Source["name"]
      }[] = []
      for (const file of files) {
        const target = path.join(folder(model), file.name)
        yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }))
        const before = fetched.reduce((total, item) => total + item.bytes, 0)
        // A file already in place at its pinned size and sha256 (from an earlier, interrupted download) is kept.
        const kept = yield* Effect.promise(() => matches(target, file))
        const result = kept
          ? { sha256: kept }
          : yield* fetchFile(model, file, target, (bytes) => (phase.bytes = before + bytes))
        fetched.push({ name: file.name, bytes: file.bytes, ...result })
        phase.bytes = before + file.bytes
      }
      state.phase = { ...phase, type: "verifying" }
      const source = fetched.some((file) => file.source === "mirror") ? ("mirror" as const) : ("huggingface" as const)
      yield* settle(model, variant, fetched, source)
    }).pipe(
      Effect.tapError((error) => Effect.sync(() => (state.error = error.message))),
      Effect.ensuring(Effect.sync(() => (state.phase = { type: "idle" }))),
      Effect.ensuring(changed()),
    )
    return yield* status()
  })

  // The files are in place: write manifest.json, choose the model, and load it once to check it here.
  const settle = Effect.fnUntraced(function* (
    model: BrainEmbedManifest.Model,
    variant: BrainEmbedManifest.Variant,
    files: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[],
    source: Installed["source"],
  ) {
    const before = yield* Effect.promise(() => readInstalled(folder(model), model))
    const installed: Installed = {
      id: model.id,
      revision: model.revision,
      variants: [...new Set([...(before?.variants ?? []), variant])],
      files: {
        ...before?.files,
        ...Object.fromEntries(files.map((file) => [file.name, { bytes: file.bytes, sha256: file.sha256 }])),
      },
      source,
      installedAt: Date.now(),
    }
    yield* Effect.promise(() => atomic(path.join(folder(model), "manifest.json"), JSON.stringify(installed, null, 2)))
    const settings = (yield* disk(true)).settings
    yield* writeSettings({ ...settings, active: { model: model.id, variant } })
    const key = BrainEmbedManifest.key(model, variant)
    state.failures.delete(key)
    state.verified.add(key)
    state.ranked.delete(key)
    yield* load(yield* required())
  })

  const required = Effect.fnUntraced(function* () {
    const current = yield* chosen(true)
    if (!current) return yield* Effect.die(new Error("the search model went missing as it was installed"))
    return current
  })

  // One file from the first source that gives it whole and right, each tried a few times, resuming what it has.
  const fetchFile = Effect.fnUntraced(function* (
    model: BrainEmbedManifest.Model,
    file: BrainEmbedManifest.File,
    target: string,
    progress: (bytes: number) => void,
  ) {
    const failures: { readonly source: Source["name"]; readonly error: EmbedError }[] = []
    for (const source of sources) {
      const url = source.url(model, file)
      if (!url) continue
      for (const _ of Array.from({ length: attempts })) {
        const result = yield* transfer(url, source, file, `${target}.part`, progress).pipe(
          Effect.map((sha256) => ({ ok: true as const, sha256 })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        )
        if (result.ok) {
          yield* Effect.promise(() => fs.rename(`${target}.part`, target))
          return { sha256: result.sha256, source: source.name }
        }
        failures.push({ source: source.name, error: result.error })
        // A wrong file or a refused redirect is not fixed by asking again; a cut is.
        if (result.error.reason !== "network") break
      }
      // What one source half-sent is not resumed from another.
      yield* Effect.promise(() => fs.rm(`${target}.part`, { force: true }))
    }
    // The last source's answer is the one to give: the copy may simply not have the file.
    const last = failures.at(-1)
    return yield* new EmbedError({
      reason: last && last.error.reason !== "missing" ? last.error.reason : "network",
      message: `Vector could not download ${file.name}: ${last ? `${last.source === "mirror" ? "Vector's copy" : "Hugging Face"}: ${last.error.message}` : "no source offers it"}`,
    })
  })

  // One request for a file (from where `.part` ends, if it exists), streamed to `.part` while its sha256 is computed.
  const transfer = Effect.fnUntraced(function* (
    url: string,
    source: Source,
    file: BrainEmbedManifest.File,
    part: string,
    progress: (bytes: number) => void,
  ) {
    const have = yield* Effect.promise(() =>
      fs.stat(part).then(
        (stat) => stat.size,
        () => 0,
      ),
    )
    if (have > file.bytes) yield* Effect.promise(() => fs.rm(part, { force: true }))
    const start = have > file.bytes ? 0 : have
    const response = yield* follow(url, source, start)
    const resumed = response.status === 206
    if (response.status === 416 && start === file.bytes) return yield* finish(part, file)
    if (response.status !== 200 && !resumed)
      return yield* new EmbedError({
        reason: response.status === 404 ? "missing" : "network",
        message: `the server answered ${response.status}`,
      })
    if (resumed && !(response.headers["content-range"] ?? "").startsWith(`bytes ${start}-`)) {
      yield* Effect.promise(() => fs.rm(part, { force: true }))
      return yield* new EmbedError({ reason: "network", message: "the server resumed from the wrong place" })
    }
    const offset = resumed ? start : 0
    const handle = yield* Effect.promise(() => fs.open(part, offset > 0 ? "a" : "w", 0o600))
    const written = { bytes: offset }
    yield* Stream.runForEach(response.stream, (chunk) =>
      Effect.gen(function* () {
        written.bytes += chunk.byteLength
        if (written.bytes > file.bytes)
          return yield* new EmbedError({
            reason: "size",
            message: `it grew past its pinned size of ${file.bytes} bytes`,
          })
        yield* Effect.promise(() => handle.write(chunk))
        progress(written.bytes)
      }),
    ).pipe(
      Effect.mapError((error) =>
        error instanceof EmbedError ? error : new EmbedError({ reason: "network", message: "the connection was cut" }),
      ),
      Effect.ensuring(Effect.promise(() => handle.close())),
      Effect.tapError((error) =>
        error.reason === "size" ? Effect.promise(() => fs.rm(part, { force: true })) : Effect.void,
      ),
    )
    if (written.bytes < file.bytes)
      return yield* new EmbedError({
        reason: "network",
        message: `the connection ended after ${written.bytes} of ${file.bytes} bytes`,
      })
    return yield* finish(part, file)
  })

  // A complete `.part`, accepted only at its pinned sha256 (or, for a preview file pinned by size, recorded as it is).
  const finish = Effect.fnUntraced(function* (part: string, file: BrainEmbedManifest.File) {
    const digest = yield* Effect.promise(() => sha256Of(part))
    if (file.sha256 && digest !== file.sha256) {
      yield* Effect.promise(() => fs.rm(part, { force: true }))
      return yield* new EmbedError({
        reason: "verify",
        message: `its sha256 was ${digest}, not the pinned ${file.sha256}`,
      })
    }
    return digest
  })

  // A request with redirects followed by hand, each only to a host the source uses and never to plain HTTP from HTTPS.
  const follow = Effect.fnUntraced(function* (url: string, source: Source, start: number) {
    const origin = new URL(url)
    const state = { url: origin }
    for (const _ of Array.from({ length: 6 })) {
      if (!allowed(state.url, source.hosts, origin))
        return yield* new EmbedError({ reason: "host", message: `Vector refused a redirect to ${state.url.host}` })
      const response = yield* http
        .execute(
          HttpClientRequest.get(state.url.toString(), {
            headers: { "accept-encoding": "identity", ...(start > 0 ? { range: `bytes=${start}-` } : {}) },
          }),
        )
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(
            () => new EmbedError({ reason: "network", message: `${state.url.host} could not be reached` }),
          ),
        )
      const location = response.headers["location"]
      if (response.status < 300 || response.status >= 400 || !location) return response
      state.url = new URL(location, state.url)
    }
    return yield* new EmbedError({ reason: "network", message: "too many redirects" })
  })

  const start = Effect.fn("BrainEmbed.start")(function* (choice: Choice = {}) {
    if (state.phase.type === "idle" && downloads)
      yield* download(choice).pipe(
        Effect.catchCause((cause) => Effect.logWarning("search model download failed", { cause })),
        Effect.forkIn(deps.scope),
      )
    yield* Effect.yieldNow
    return yield* status()
  })

  const install = Effect.fn("BrainEmbed.install")(function* (from: string, choice: Choice = {}) {
    if (state.phase.type !== "idle")
      return yield* new EmbedError({ reason: "busy", message: "The search model is already downloading." })
    const model = models[choice.model ?? BrainEmbedManifest.DEFAULT]
    const variant = choice.variant ?? "int8"
    const files = BrainEmbedManifest.files(model, variant)
    state.phase = {
      type: "verifying",
      model: model.id,
      variant,
      bytes: 0,
      total: files.reduce((total, file) => total + file.bytes, 0),
    }
    yield* Effect.gen(function* () {
      yield* Effect.promise(() => ensureFolder(folder(model)))
      const copied: { name: string; bytes: number; sha256: string }[] = []
      for (const file of files) {
        // The model's own layout (onnx/model_quantized.onnx), or the release's flat names (arctic-…-model_quantized.onnx).
        const candidates = [
          path.join(from, file.name),
          path.join(from, path.basename(file.name)),
          path.join(from, BrainEmbedManifest.asset(model, file)),
        ]
        const found = yield* Effect.promise(() => firstFile(candidates))
        if (!found) return yield* new EmbedError({ reason: "missing", message: `${from} has no ${file.name}.` })
        const size = yield* Effect.promise(() => fs.stat(found).then((stat) => stat.size))
        if (size !== file.bytes)
          return yield* new EmbedError({
            reason: "size",
            message: `${found} is ${size} bytes, not the pinned ${file.bytes}.`,
          })
        const digest = yield* Effect.promise(() => sha256Of(found))
        if (file.sha256 && digest !== file.sha256)
          return yield* new EmbedError({
            reason: "verify",
            message: `${found} has sha256 ${digest}, not the pinned ${file.sha256}.`,
          })
        const target = path.join(folder(model), file.name)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
          await fs.copyFile(found, `${target}.part`)
          await fs.chmod(`${target}.part`, 0o600)
          await fs.rename(`${target}.part`, target)
        })
        copied.push({ name: file.name, bytes: file.bytes, sha256: digest })
      }
      yield* settle(model, variant, copied, "folder")
    }).pipe(
      Effect.tapError((error) => Effect.sync(() => (state.error = error.message))),
      Effect.ensuring(Effect.sync(() => (state.phase = { type: "idle" }))),
      Effect.ensuring(changed()),
    )
    return yield* status()
  })

  const remove = Effect.fn("BrainEmbed.remove")(function* () {
    const found = yield* disk(true)
    yield* Effect.promise(() =>
      Promise.all(Object.values(models).map((model) => fs.rm(folder(model), { recursive: true, force: true }))),
    )
    yield* writeSettings({ ...(found.settings.paused ? { paused: true } : {}) })
    state.failures.clear()
    state.verified.clear()
    state.ranked.clear()
    state.error = undefined
    yield* changed()
    return yield* status()
  })

  const pause = Effect.fn("BrainEmbed.pause")(function* (paused: boolean) {
    const found = yield* disk(true)
    yield* writeSettings({ ...found.settings, paused })
    yield* changed()
    return yield* status()
  })

  // --- Running ------------------------------------------------------------------------------------------------------

  const thresholdOf = (current: Chosen) => {
    const pinned = goldens[current.model.id]
    if (!pinned || pinned.revision !== current.model.revision) return 0
    if (current.variant === "fp32") return pinned.fp32 ? BrainEmbedManifest.CHECK : BrainEmbedManifest.CHECK_FALLBACK
    return BrainEmbedManifest.CHECK
  }

  // The model as the background reader loads it, with the canaries and the least each must match.
  const embedModel = (current: Chosen): BrainWorker.EmbedModel => {
    const pinned = goldens[current.model.id]
    const same = pinned && pinned.revision === current.model.revision ? pinned : undefined
    const canaries = (current.variant === "fp32" ? (same?.fp32 ?? same?.int8) : same?.int8) ?? []
    const data = current.variant === "int8" ? current.model.files.data : undefined
    const graph = BrainEmbedManifest.files(current.model, current.variant)[0]!
    const base = folder(current.model)
    return {
      key: current.key,
      settings: {
        dims: current.model.dims,
        pooling: current.model.pooling,
        maxTokens: current.model.maxTokens,
        queryTokens: current.model.queryTokens,
        query: current.model.query,
      },
      canaries: canaries.map((canary) => ({ text: canary.text, role: canary.role, vector: [...canary.vector] })),
      threshold: thresholdOf(current),
      files: async () => ({
        wasm: new Uint8Array(await fs.readFile(options.wasm ?? wasmPath())),
        model: new Uint8Array(await fs.readFile(path.join(base, graph.name))),
        ...(data
          ? { data: new Uint8Array(await fs.readFile(path.join(base, data.name))), dataName: path.basename(data.name) }
          : {}),
        tokenizer: await fs.readFile(path.join(base, current.model.files.tokenizer.name), "utf8"),
        config: await fs.readFile(path.join(base, current.model.files.config.name), "utf8"),
      }),
    }
  }

  // Once per process: every file is the size and sha256 it was installed at, before it is loaded.
  const verify = Effect.fnUntraced(function* (current: Chosen) {
    if (state.verified.has(current.key)) return true
    const files = BrainEmbedManifest.files(current.model, current.variant)
    const problems = yield* Effect.promise(() =>
      Promise.all(
        files.map(async (file) => {
          const target = path.join(folder(current.model), file.name)
          const size = await fs.stat(target).then(
            (stat) => stat.size,
            () => -1,
          )
          if (size !== file.bytes) return `${file.name} is missing or the wrong size`
          const digest = await sha256Of(target)
          const expected = file.sha256 ?? current.installed.files[file.name]?.sha256
          return digest === expected ? undefined : `${file.name} changed since it was installed`
        }),
      ),
    )
    const problem = problems.find((item) => item !== undefined)
    if (problem) {
      state.failures.set(current.key, {
        message: `The search model's files were changed: ${problem}. Remove it and download it again.`,
        check: false,
      })
      yield* changed()
      return false
    }
    state.verified.add(current.key)
    return true
  })

  // Loaded into the background reader and checked; a model that fails is not used again in this process.
  const load = Effect.fnUntraced(function* (current: Chosen) {
    if (state.failures.has(current.key)) return false
    if (!(yield* verify(current))) return false
    const loaded = yield* worker
      .embed({ model: embedModel(current), texts: [], role: "passage", priority: "background" })
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (error.reason !== "check") return false
            state.failures.set(current.key, { message: error.message, check: true })
            yield* changed()
            return false
          }),
        ),
      )
    if (!loaded) return false
    return yield* ranks(current)
  })

  // A model with no pinned vectors is checked by ranking instead: the canary request must sit nearer the passage that
  // answers it than the one that does not.
  const ranks = Effect.fnUntraced(function* (current: Chosen) {
    if (thresholdOf(current) > 0 || state.ranked.has(current.key)) return true
    const texts = BrainEmbedManifest.CANARIES.map((canary) => canary.text)
    const vectors = yield* Effect.all([
      worker.embed({ model: embedModel(current), texts: [texts[0]], role: "query", priority: "background" }),
      worker.embed({ model: embedModel(current), texts: texts.slice(1), role: "passage", priority: "background" }),
    ]).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!vectors) return false
    const [query] = vectors[0]
    const [answer, other] = vectors[1]
    if (BrainVector.cosine(query!, answer!) > BrainVector.cosine(query!, other!) + 0.02) {
      state.ranked.add(current.key)
      return true
    }
    state.failures.set(current.key, {
      message: "The search model did not rank its test sentences as it should on this computer.",
      check: true,
    })
    yield* changed()
    return false
  })

  const current = Effect.fn("BrainEmbed.current")(function* () {
    const found = yield* chosen()
    if (!found || state.failures.has(found.key)) return undefined
    return {
      key: found.key,
      floor: found.model.floor,
      dims: found.model.dims,
      paused: (yield* disk()).settings.paused === true,
    }
  })

  const warm = Effect.fn("BrainEmbed.warm")(function* () {
    if (state.warming) return
    const found = yield* chosen()
    if (!found || state.failures.has(found.key) || (yield* worker.loaded(found.key))) return
    state.warming = true
    yield* load(found).pipe(
      Effect.catchCause((cause) => Effect.logWarning("search model could not load", { cause })),
      Effect.ensuring(Effect.sync(() => (state.warming = false))),
      Effect.forkIn(deps.scope),
    )
  })

  const prepare = Effect.fn("BrainEmbed.prepare")(function* () {
    const found = yield* chosen()
    if (!found || state.failures.has(found.key)) return false
    if (yield* worker.loaded(found.key)) return true
    return yield* load(found)
  })

  const query = Effect.fn("BrainEmbed.query")(function* (text: string) {
    const found = yield* chosen()
    if (!found || state.failures.has(found.key)) return undefined
    // A cold model never holds up a request: this one uses keywords and code links while it loads for the next.
    if (!(yield* worker.loaded(found.key))) {
      yield* warm()
      return undefined
    }
    return yield* worker.embed({ model: embedModel(found), texts: [text], role: "query", priority: "query" }).pipe(
      Effect.map((vectors) => vectors[0]),
      Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.succeed(undefined) }),
      Effect.catch(() => Effect.succeed(undefined)),
    )
  })

  const embed = Effect.fn("BrainEmbed.embed")(function* (texts: readonly string[]) {
    const found = yield* chosen()
    if (!found || state.failures.has(found.key)) return undefined
    if (!(yield* worker.loaded(found.key)) && !(yield* load(found))) return undefined
    return yield* worker.embed({ model: embedModel(found), texts, role: "passage", priority: "background" }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (error.reason === "check") {
            state.failures.set(found.key, { message: error.message, check: true })
            yield* changed()
          }
          return undefined
        }),
      ),
    )
  })

  return Service.of({
    status,
    download,
    start,
    install,
    remove,
    pause,
    current,
    query,
    embed,
    warm,
    prepare,
    changed: Queue.take(deps.changes),
  })
}

// --- Files ------------------------------------------------------------------------------------------------------

// The wasm this build ships: an absolute path from Bun (or its compiled binary), a path beside the bundle from Node.
function wasmPath() {
  const shipped = ortWasm as unknown as string
  return path.isAbsolute(shipped) ? shipped : fileURLToPath(new URL(shipped, import.meta.url))
}

async function readJson<T>(file: string): Promise<T | undefined> {
  return fs
    .readFile(file, "utf8")
    .then((text) => JSON.parse(text) as T)
    .catch(() => undefined)
}

// What manifest.json says is installed in a model's folder, if it names this model at this revision.
async function readInstalled(dir: string, model: BrainEmbedManifest.Model) {
  const installed = await readJson<Installed>(path.join(dir, "manifest.json"))
  if (!installed || installed.id !== model.id || installed.revision !== model.revision) return undefined
  if (!Array.isArray(installed.variants) || installed.variants.length === 0) return undefined
  return installed
}

async function ensureFolder(dir: string) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await fs.chmod(dir, 0o700)
}

// Written beside, then renamed over: a reader sees the old file or the new one, never half of one.
async function atomic(file: string, text: string) {
  const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`
  await fs.writeFile(temporary, text, { mode: 0o600 })
  await fs.rename(temporary, file)
}

function sha256Of(file: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256")
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject)
  })
}

// A file already in place at its pinned size and sha256 is not downloaded again; its sha256 when it is.
async function matches(target: string, file: BrainEmbedManifest.File) {
  const size = await fs.stat(target).then(
    (stat) => stat.size,
    () => -1,
  )
  if (size !== file.bytes) return undefined
  const digest = await sha256Of(target)
  return !file.sha256 || digest === file.sha256 ? digest : undefined
}

async function firstFile(candidates: readonly string[]) {
  for (const candidate of candidates)
    if (
      await fs.stat(candidate).then(
        (stat) => stat.isFile(),
        () => false,
      )
    )
      return candidate
  return undefined
}

function allowed(url: URL, hosts: readonly string[], origin: URL) {
  const host = url.hostname.toLowerCase()
  const listed = hosts.some((pattern) =>
    pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern,
  )
  // Never from HTTPS down to plain HTTP; a source that starts on plain HTTP (a test's local server) stays on its host.
  const secure = url.protocol === "https:" || (origin.protocol === "http:" && url.protocol === "http:")
  return listed && secure
}
