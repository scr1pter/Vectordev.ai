export * as BrainWorker from "./host"

import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { BrainWorkerEntry } from "./entry"
import { BrainWorkerProtocol } from "./protocol"

// Where documents are read: a worker thread, so a file that sends a parser into a loop or makes it grow can be stopped
// without stopping the engine. The worker is started from its bundled source as an eval worker, which runs the same
// way under Bun (the CLI), Node and Electron's utility process (the desktop engine) and needs no second file inside the
// signed app. From source under Bun it starts from entry.ts itself. When no worker can start, or one keeps dying,
// documents are read on the main thread instead under tighter limits, and `status` says why.

export class ExtractError extends Schema.TaggedErrorClass<ExtractError>()("BrainWorker.ExtractError", {
  /** timeout: stopped for taking too long; crashed: the worker died; failed: the reader threw; invalid: bad answer. */
  reason: Schema.Literals(["timeout", "crashed", "failed", "invalid"]),
  message: Schema.String,
}) {}

export type Refused = {
  readonly type: "refused"
  readonly reason: BrainWorkerProtocol.Refusal
  readonly message: string
}

export type Status = {
  readonly mode: "worker" | "in-process"
  /** Why documents are read on the main thread, in words for Settings. */
  readonly reason?: string
  /** Worker threads alive now. */
  readonly threads: number
}

export type Input = { readonly name: string; readonly bytes: Uint8Array; readonly mime?: string }

export interface Interface {
  readonly extract: (
    input: Input & { readonly repository: string; readonly lineage: string; readonly document: string },
  ) => Effect.Effect<
    { readonly type: "extracted"; readonly structured: BrainWorkerProtocol.Structured } | Refused,
    ExtractError
  >
  readonly probe: (
    input: Input,
  ) => Effect.Effect<{ readonly type: "probed"; readonly probe: BrainWorkerProtocol.Probed } | Refused, ExtractError>
  readonly status: () => Effect.Effect<Status>
}

export class Service extends Context.Service<Service, Interface>()("@vector/BrainWorker") {}

/** The worker's bundled source. A build provides it (the engine carries it as a string); from source there is none. */
export class Source extends Context.Service<Source, { readonly load: Effect.Effect<string | undefined> }>()(
  "@vector/BrainWorkerSource",
) {}

export type Options = {
  /** Milliseconds a new worker has to say it is ready. */
  readonly ready?: number
  /** Milliseconds a document may take to read, by kind, before its worker is stopped. */
  readonly timeout?: { readonly pdf: number; readonly other: number }
  /** Milliseconds a worker with nothing to do stays alive. */
  readonly idle?: number
  /** Read on the main thread only, as tests do. */
  readonly inline?: boolean
}

const DEFAULTS = {
  ready: 5_000,
  timeout: { pdf: 120_000, other: 30_000 },
  idle: 5 * 60_000,
}

// Node and Electron honour these; Bun ignores them, so there the readers' own caps and terminate are the guard.
const RESOURCES = { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 }

/** Two crashes this close together and documents are read on the main thread for the rest of the process. */
const CRASH_WINDOW = 10 * 60_000

const ENTRY = new URL("./entry.ts", import.meta.url)

export const layerWith = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const source = yield* Source
      const bundled = yield* source.load
      const host = make(bundled, options)
      yield* Effect.addFinalizer(() => Effect.sync(host.close))
      return host.service
    }),
  )

export const layer = layerWith()

/** Reads on the main thread, with no worker: what tests of the knowledge store use. */
export const layerInline = Layer.effect(
  Service,
  Effect.gen(function* () {
    const host = make(undefined, { inline: true })
    yield* Effect.addFinalizer(() => Effect.sync(host.close))
    return host.service
  }),
)

/** No bundled source: replaced by the engine, whose builds carry one. */
export const sourceNode = makeGlobalNode({
  service: Source,
  layer: Layer.succeed(Source, Source.of({ load: Effect.succeed(undefined) })),
  deps: [],
})

export const node = makeGlobalNode({ service: Service, layer, deps: [sourceNode] })

function make(bundled: string | undefined, options: Options) {
  const ready = options.ready ?? DEFAULTS.ready
  const timeout = options.timeout ?? DEFAULTS.timeout
  const idle = options.idle ?? DEFAULTS.idle
  // From source under Bun the worker can start from entry.ts; anywhere else it needs the bundled source.
  const fromSource = bundled === undefined && Boolean(process.versions.bun) && existsSync(fileURLToPath(ENTRY))
  const state: {
    worker?: Worker
    starting?: Promise<Worker>
    mode: Status["mode"]
    reason?: string
    threads: number
    crashes: number[]
    next: number
    waiting: Map<number, { resolve: (message: unknown) => void; reject: (error: ExtractError) => void }>
    timer?: ReturnType<typeof setTimeout>
  } = {
    mode: options.inline || (bundled === undefined && !fromSource) ? "in-process" : "worker",
    ...(options.inline
      ? { reason: "Tests read documents on the main thread." }
      : bundled === undefined && !fromSource
        ? { reason: "This build of Vector does not include its background reader." }
        : {}),
    threads: 0,
    crashes: [],
    next: 1,
    waiting: new Map(),
  }
  const lock = Semaphore.makeUnsafe(1)

  // One worker failed for good: whatever waited on it fails, and two crashes in the window end worker mode.
  const crashed = (worker: Worker, message: string) => {
    if (state.worker === worker) state.worker = undefined
    const waiting = [...state.waiting.values()]
    state.waiting.clear()
    waiting.forEach((item) => item.reject(new ExtractError({ reason: "crashed", message })))
    const now = Date.now()
    state.crashes = [...state.crashes.filter((at) => now - at < CRASH_WINDOW), now]
    if (state.crashes.length >= 2) fallBack("Vector's background reader stopped twice in 10 minutes.")
  }

  const fallBack = (reason: string) => {
    state.mode = "in-process"
    state.reason = reason
    stop()
  }

  const stop = () => {
    clearTimeout(state.timer)
    const worker = state.worker
    state.worker = undefined
    state.starting = undefined
    if (worker) void worker.terminate()
  }

  const start = () =>
    new Promise<Worker>((resolve, reject) => {
      const worker =
        bundled !== undefined
          ? new Worker(bundled, { eval: true, execArgv: [], resourceLimits: RESOURCES })
          : new Worker(ENTRY, { execArgv: [], resourceLimits: RESOURCES })
      state.threads++
      // An idle worker never keeps a CLI process alive; a request's own timer does while it waits.
      worker.unref()
      const started = { done: false }
      const timer = setTimeout(() => {
        void worker.terminate()
        reject(new Error(`it did not start within ${Math.round(ready / 1000)} seconds`))
      }, ready)
      worker.on("message", (message: unknown) => {
        if (!started.done && isReady(message)) {
          started.done = true
          clearTimeout(timer)
          resolve(worker)
          return
        }
        const id = typeof message === "object" && message !== null && "id" in message ? message.id : undefined
        const waiting = typeof id === "number" ? state.waiting.get(id) : undefined
        if (!waiting || typeof id !== "number") return
        state.waiting.delete(id)
        waiting.resolve(message)
      })
      worker.on("error", (error) => {
        if (!started.done) {
          clearTimeout(timer)
          reject(error)
          return
        }
        crashed(worker, error.message)
      })
      worker.on("exit", () => {
        state.threads--
        if (state.worker === worker && started.done) crashed(worker, "Vector's background reader stopped.")
      })
    })

  // The running worker, started on first use. A worker that cannot start ends worker mode for this process.
  const running = Effect.fnUntraced(function* () {
    if (state.worker) return state.worker
    state.starting ??= start()
    const worker = yield* Effect.tryPromise({
      try: () => state.starting!,
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipe(
      Effect.catch((message: string) => {
        fallBack(`Vector's background reader could not start here: ${message}`)
        return Effect.succeed(undefined)
      }),
    )
    state.starting = undefined
    if (worker && state.mode === "worker") state.worker = worker
    return state.mode === "worker" ? worker : undefined
  })

  const send = (worker: Worker, request: BrainWorkerProtocol.Request) =>
    Effect.callback<unknown, ExtractError>((resume) => {
      state.waiting.set(request.id, {
        resolve: (message) => resume(Effect.succeed(message)),
        reject: (error) => resume(Effect.fail(error)),
      })
      worker.postMessage(request)
      return Effect.sync(() => state.waiting.delete(request.id))
    })

  const call = (request: BrainWorkerProtocol.Request, ms: number) =>
    lock.withPermit(
      Effect.gen(function* () {
        clearTimeout(state.timer)
        const worker = state.mode === "worker" ? yield* running() : undefined
        const answer = worker
          ? yield* send(worker, request).pipe(
              Effect.timeoutOrElse({
                duration: ms,
                orElse: () =>
                  Effect.sync(stop).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new ExtractError({
                          reason: "timeout",
                          message: `Reading took longer than ${Math.round(ms / 1000)} seconds, so Vector stopped it.`,
                        }),
                      ),
                    ),
                  ),
              }),
            )
          : yield* Effect.promise(() =>
              BrainWorkerEntry.handle(request.type === "ping" ? request : { ...request, limits: "inline" }),
            )
        if (state.worker) {
          const current = state.worker
          state.timer = setTimeout(() => {
            if (state.worker === current) stop()
          }, idle)
          state.timer.unref?.()
        }
        const decoded = Schema.decodeUnknownOption(BrainWorkerProtocol.Response)(answer)
        if (Option.isNone(decoded) || !("id" in decoded.value) || decoded.value.id !== request.id)
          return yield* new ExtractError({ reason: "invalid", message: "Vector's background reader gave an answer it could not use." })
        if (decoded.value.type === "failed")
          return yield* new ExtractError({ reason: "failed", message: decoded.value.message })
        return decoded.value
      }),
    )

  const id = () => state.next++

  const service = Service.of({
    extract: Effect.fn("BrainWorker.extract")(function* (input) {
      const answer = yield* call(
        {
          id: id(),
          type: "extract",
          name: input.name,
          bytes: input.bytes,
          ...(input.mime ? { mime: input.mime } : {}),
          repository: input.repository,
          lineage: input.lineage,
          document: input.document,
          limits: "worker",
        },
        isPdf(input) ? timeout.pdf : timeout.other,
      )
      if (answer.type === "refused") return { type: "refused" as const, reason: answer.reason, message: answer.message }
      if (answer.type !== "extracted")
        return yield* new ExtractError({ reason: "invalid", message: "Vector's background reader answered out of turn." })
      return { type: "extracted" as const, structured: answer.result }
    }),
    probe: Effect.fn("BrainWorker.probe")(function* (input) {
      const answer = yield* call(
        {
          id: id(),
          type: "probe",
          name: input.name,
          bytes: input.bytes,
          ...(input.mime ? { mime: input.mime } : {}),
          limits: "worker",
        },
        isPdf(input) ? timeout.pdf : timeout.other,
      )
      if (answer.type === "refused") return { type: "refused" as const, reason: answer.reason, message: answer.message }
      if (answer.type !== "probed")
        return yield* new ExtractError({ reason: "invalid", message: "Vector's background reader answered out of turn." })
      return { type: "probed" as const, probe: answer.result }
    }),
    status: () =>
      Effect.sync(() => ({
        mode: state.mode,
        ...(state.reason ? { reason: state.reason } : {}),
        threads: state.threads,
      })),
  })

  return { service, close: stop }
}

function isReady(message: unknown) {
  return typeof message === "object" && message !== null && "type" in message && message.type === "ready"
}

// pdf.js takes a header anywhere in the first kilobyte, so that is where a PDF is told by its bytes.
function isPdf(input: Input) {
  return new TextDecoder("latin1").decode(input.bytes.subarray(0, 1024)).includes("%PDF-")
}
