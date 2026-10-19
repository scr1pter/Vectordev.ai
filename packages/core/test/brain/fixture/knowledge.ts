// The knowledge store over a brain in memory (or a file two services share), with a temporary repository, config and
// data folder, so nothing touches the user's own. Documents are read on the main thread unless a test gives a worker.

import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainWorkerEntry } from "@vectordevai/core/brain/worker/entry"
import { BrainWorker } from "@vectordevai/core/brain/worker/host"
import { Global } from "@vectordevai/core/global"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { tmpdir } from "../../fixture/tmpdir"

export type Setup = {
  readonly knowledge: BrainKnowledge.Interface
  readonly brain: Brain.Interface
  readonly db: BrainDatabase.Database
  readonly place: Brain.Place
  readonly root: string
  readonly dir: string
}

export async function withKnowledge<A, E>(
  body: (setup: Setup) => Effect.Effect<A, E>,
  options: {
    readonly files?: Record<string, string | Uint8Array>
    readonly held?: boolean
    readonly worker?: Layer.Layer<BrainWorker.Service>
    /** Make the repository a git working tree, which documents are linked to the code of. */
    readonly git?: boolean
  } = {},
) {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "repo")
  await fs.mkdir(root, { recursive: true })
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await fs.writeFile(path.join(root, name), content)
  }
  if (options.git) execFileSync("git", ["init", "-q"], { cwd: root })
  const place = placeFor(root, options.held)
  return await Effect.runPromise(
    services(place, body, { file: ":memory:", dir: tmp.path, worker: options.worker ?? BrainWorker.layerInline }),
  )
}

export function placeFor(root: string, held = false): Brain.Place {
  return {
    repository: "repo-1",
    root,
    sources: [
      { path: path.join(root, ".vector", "RULES.md"), type: "rules" },
      { path: path.join(root, ".vector", "BRAIN.md"), type: "brain" },
    ],
    held,
  }
}

/** The services over one database file, as one process has them; two calls on one file are two processes. */
export function services<A, E>(
  place: Brain.Place,
  body: (setup: Setup) => Effect.Effect<A, E>,
  options: {
    readonly file: string
    readonly dir: string
    readonly worker: Layer.Layer<BrainWorker.Service>
    readonly owner?: string
  },
) {
  const layer = BrainKnowledge.layerWith({ ...(options.owner ? { owner: options.owner } : {}) }).pipe(
    Layer.provide(LayerNode.compile(Ripgrep.node)),
    Layer.provideMerge(Brain.layer),
    Layer.provideMerge(options.worker),
    Layer.provideMerge(BrainDatabase.layerFor(options.file).pipe(Layer.fresh)),
    Layer.provide(
      Layer.succeed(
        Global.Service,
        Global.make({ config: path.join(options.dir, "config"), data: path.join(options.dir, "data") }),
      ),
    ),
  )
  return Effect.gen(function* () {
    const knowledge = yield* BrainKnowledge.Service
    const brain = yield* Brain.Service
    const database = yield* BrainDatabase.Service
    return yield* body({ knowledge, brain, db: database.db, place, root: place.root, dir: options.dir })
  }).pipe(Effect.provide(layer))
}

/** A reader on the main thread that records each document it reads, and can be made to wait. */
export function countingWorker(calls: string[], gate?: Promise<unknown>) {
  return Layer.succeed(
    BrainWorker.Service,
    BrainWorker.Service.of({
      extract: (input) =>
        Effect.promise(async () => {
          calls.push(input.document)
          await gate
          const answer = await BrainWorkerEntry.handle({ id: 1, type: "extract", ...input, limits: "inline" })
          if (answer.type === "extracted") return { type: "extracted" as const, structured: answer.result }
          if (answer.type === "refused")
            return { type: "refused" as const, reason: answer.reason, message: answer.message }
          throw new Error(`unexpected answer ${answer.type}`)
        }),
      probe: () => Effect.die("not used"),
      status: () => Effect.succeed({ mode: "worker" as const, threads: 0 }),
    }),
  )
}

/** Adds a document and waits until it is searchable, held or failed. */
export const added = (setup: Setup, input: BrainKnowledge.AddInput) =>
  Effect.gen(function* () {
    const result = yield* setup.knowledge.add(setup.place, input)
    if (result.type === "refused") return { result, document: undefined }
    const document = yield* setup.knowledge.wait(setup.place, result.document.id, "searchable", 20_000)
    return { result, document }
  })

export const text = (name: string, body: string) =>
  ({ type: "text", name, text: body, origin: "upload" }) satisfies BrainKnowledge.AddInput
