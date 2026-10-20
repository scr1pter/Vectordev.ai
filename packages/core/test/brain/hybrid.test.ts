import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BrainEmbed } from "@vectordevai/core/brain/embed"
import { BrainEmbedManifest } from "@vectordevai/core/brain/embed-manifest"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainWorker } from "@vectordevai/core/brain/worker/host"
import { Global } from "@vectordevai/core/global"
import { tmpdir } from "../fixture/tmpdir"
import { SPEC_V1 } from "./fixture/documents"
import { added, placeFor, services, text, withKnowledge } from "./fixture/knowledge"
import * as Fixture from "./fixture/onnx"

// Search by meaning beside keywords and code links. Without the model nothing changes; with it (the hash embedder,
// which places words that share their letters near each other, or the fixture model through ONNX Runtime) a record
// keywords miss comes in, through the same fusion, gate and budget. Records are embedded before passages, in the
// background, and Pause holds that until it is resumed.

const ask = (query: string, overrides: Partial<Parameters<BrainKnowledge.Interface["recall"]>[1]> = {}) => ({
  query,
  files: [],
  tier: "standard" as const,
  tight: false,
  personal: true,
  exclude: new Set<string>(),
  sessionID: "ses_1",
  ...overrides,
})

const LIMITS = "# Rate limits\n\nThe rate limiter allows 100 requests per minute for each client.\n"
const AUDIT = "# Audit\n\nThe audit log keeps entries for 7 years.\n"

const QUERIES = [
  "what is the refresh token TTL?",
  "how many times may a client retry after a 429?",
  "ratelimiter settings",
  "how do I center a div?",
  "hi",
  "ok",
]

// The fixture model, installed from a folder, with its canaries pinned.
const fixtureModel = () => (data: string) =>
  BrainEmbed.layerWith({
    dir: path.join(data, "models", "embedding"),
    models: { "arctic-embed-xs-q8": Fixture.manifest() },
    golden: {
      "arctic-embed-xs-q8": {
        revision: Fixture.manifest().revision,
        int8: BrainEmbedManifest.CANARIES.map((canary) => ({
          text: canary.text,
          role: canary.role,
          vector: Array.from(Fixture.expected(canary.text)),
        })),
      },
    },
    downloads: false,
  }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(BrainWorker.layerInline),
    Layer.provide(Layer.succeed(Global.Service, Global.make({ data }))),
  )

describe("search by meaning", () => {
  test("with no model, and with a model not downloaded, recall and search give what keywords and code links give", async () => {
    const scenario = (setup: Parameters<Parameters<typeof withKnowledge>[0]>[0]) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        yield* added(setup, text("Rate limits.md", LIMITS))
        const recalled = yield* Effect.forEach(QUERIES, (query) => setup.knowledge.recall(setup.place, ask(query)))
        // Document ids are new on every run; the cards are what must match.
        const searched = yield* Effect.forEach(QUERIES, (query) =>
          setup.knowledge
            .search(setup.place, { query, personal: true })
            .pipe(Effect.map((cards) => cards.map((card) => ({ ...card, document: card.title })))),
        )
        return { recalled, searched, model: yield* setup.knowledge.model(setup.place) }
      })
    const off = await withKnowledge(scenario)
    // The real service with no model on disk, as every install starts.
    const absent = await withKnowledge(scenario, {
      embed: (data) =>
        BrainEmbed.layerWith({ dir: path.join(data, "models", "embedding"), downloads: false }).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(BrainWorker.layerInline),
          Layer.provide(Layer.succeed(Global.Service, Global.make({ data }))),
        ),
    })
    expect(absent.recalled).toEqual(off.recalled)
    expect(absent.searched).toEqual(off.searched)
    expect(absent.model).toMatchObject({ state: "absent", downloads: false, embedded: { done: 0 } })
    // Keywords alone miss a request that names the limiter in one word.
    expect(off.recalled[2]!.tokens).toBe(0)
  }, 60_000)

  test("a record keywords miss is found by meaning, through the same gate and budget, and says why", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Auth spec.md", SPEC_V1))
          const limits = yield* added(setup, text("Rate limits.md", LIMITS))
          yield* added(setup, text("Audit.md", AUDIT))
          const ready = yield* setup.knowledge.wait(setup.place, limits.document!.id, "ready", 10_000)
          return {
            ready,
            meaning: yield* setup.knowledge.recall(setup.place, ask("ratelimiter settings")),
            keywords: yield* setup.knowledge.recall(setup.place, ask("what is the refresh token TTL?")),
            unrelated: yield* setup.knowledge.recall(setup.place, ask("how do I center a div?")),
            hi: yield* setup.knowledge.recall(setup.place, ask("hi", { tier: "light" })),
            ok: yield* setup.knowledge.recall(setup.place, ask("ok", { tier: "light" })),
            chat: yield* setup.knowledge.recall(setup.place, ask("ratelimiter settings", { tier: "chat" })),
            searched: yield* setup.knowledge.search(setup.place, { query: "ratelimiter settings", personal: true }),
            guest: yield* setup.knowledge.recall(setup.place, ask("ratelimiter settings", { personal: false })),
          }
        }),
      { embed: BrainEmbed.layerHash() },
    )
    expect(result.ready?.status).toBe("ready")
    expect(result.meaning.text).toContain("The rate limiter allows 100 requests per minute")
    expect(Object.values(result.meaning.why)).toContain("meaning")
    expect(result.meaning.tokens).toBeLessThanOrEqual(
      BrainKnowledge.budget("standard", { documents: true, tight: false }),
    )
    expect(result.keywords.text).toContain("Refresh tokens expire after 14 days.")
    // Nothing the specs say is near a question about CSS, and a greeting means nothing at all.
    expect(result.unrelated.tokens).toBe(0)
    expect(result.hi.tokens).toBe(0)
    expect(result.ok.tokens).toBe(0)
    expect(result.chat.tokens).toBe(0)
    expect(result.searched.map((card) => card.text).join(" ")).toContain("rate limiter allows 100 requests")
    // An uploaded document is private: a session a guest is in, or a model that may train, finds none of it by meaning.
    expect(result.guest.tokens).toBe(0)
  }, 60_000)

  test("records are embedded before passages, the document goes from searchable to ready, and Pause holds it", async () => {
    await using tmp = await tmpdir()
    const source = await Fixture.write(path.join(tmp.path, "source"))
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* setup.embed.pause(true)
          yield* setup.embed.install(source)
          const kept = yield* added(setup, text("Auth spec.md", SPEC_V1))
          yield* Effect.sleep("300 millis")
          const paused = {
            document: (yield* setup.knowledge.documents(setup.place, { personal: true }))[0]!,
            vectors: yield* setup.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM brain_vector`),
            model: yield* setup.knowledge.model(setup.place),
          }
          yield* setup.embed.pause(false)
          const ready = yield* setup.knowledge.wait(setup.place, kept.document!.id, "ready", 20_000)
          const order = yield* setup.db.all<{ type: string }>(
            sql`SELECT i.type AS type FROM brain_vector v JOIN brain_item i ON i.id = v.item ORDER BY v.embedded_at, v.item`,
          )
          return { paused, ready, order, model: yield* setup.knowledge.model(setup.place) }
        }),
      { embed: fixtureModel() },
    )
    expect(result.paused.document.status).toBe("searchable")
    expect(result.paused.vectors?.count).toBe(0)
    expect(result.paused.model).toMatchObject({ state: "ready", paused: true, embedded: { done: 0 } })
    expect(result.ready?.status).toBe("ready")
    expect(result.ready?.embedModel).toBe(BrainEmbedManifest.key(Fixture.manifest(), "int8"))
    expect(result.ready?.stats.embedded).toBe(result.ready!.stats.records + result.ready!.stats.passages)
    const types = result.order.map((row) => row.type)
    expect(types.lastIndexOf("record")).toBeLessThan(types.indexOf("passage"))
    expect(result.model).toMatchObject({ state: "ready", embedded: { done: types.length, total: types.length } })
    expect(result.model.paused).toBeUndefined()
  }, 60_000)

  test("waiting for ready returns a document once it is ready, never while its status still says embedding", async () => {
    // A model slow enough that the embedder rests between batches, as it does on a real one.
    const slow = Layer.effect(
      BrainEmbed.Service,
      Effect.gen(function* () {
        const hash = yield* BrainEmbed.Service
        return BrainEmbed.Service.of({
          ...hash,
          embed: (texts) => Effect.sleep("150 millis").pipe(Effect.andThen(hash.embed(texts))),
        })
      }),
    ).pipe(Layer.provide(BrainEmbed.layerHash()))
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const kept = yield* added(setup, text("Audit.md", AUDIT))
          return yield* setup.knowledge.wait(setup.place, kept.document!.id, "ready", 10_000)
        }),
      { embed: slow },
    )
    expect(result?.status).toBe("ready")
    expect(result?.stats.embedded).toBe(result!.stats.records + result!.stats.passages)
  }, 30_000)

  test("forgetting a document forgets its vectors, so nothing of it is found by meaning again", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const kept = yield* added(setup, text("Rate limits.md", LIMITS))
          yield* setup.knowledge.wait(setup.place, kept.document!.id, "ready", 10_000)
          const before = yield* setup.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM brain_vector`)
          yield* setup.knowledge.remove(setup.place, kept.document!.id)
          return {
            before,
            after: yield* setup.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM brain_vector`),
            recalled: yield* setup.knowledge.recall(setup.place, ask("ratelimiter settings")),
          }
        }),
      { embed: BrainEmbed.layerHash() },
    )
    expect(result.before?.count).toBeGreaterThan(0)
    expect(result.after?.count).toBe(0)
    expect(result.recalled.tokens).toBe(0)
  }, 30_000)

  test("removing the model removes its vectors, and documents are searchable by keywords again", async () => {
    await using tmp = await tmpdir()
    const source = await Fixture.write(path.join(tmp.path, "source"))
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* setup.embed.install(source)
          const kept = yield* added(setup, text("Audit.md", AUDIT))
          const ready = yield* setup.knowledge.wait(setup.place, kept.document!.id, "ready", 20_000)
          yield* setup.embed.remove()
          const after = yield* Effect.gen(function* () {
            for (const _ of Array.from({ length: 100 })) {
              const document = (yield* setup.knowledge.documents(setup.place, { personal: true }))[0]!
              if (document.status === "searchable") return document
              yield* Effect.sleep("50 millis")
            }
            return undefined
          })
          return {
            ready,
            after,
            vectors: yield* setup.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM brain_vector`),
            recalled: yield* setup.knowledge.recall(setup.place, ask("how long does the audit log keep entries?")),
          }
        }),
      { embed: fixtureModel() },
    )
    expect(result.ready?.status).toBe("ready")
    expect(result.after).toMatchObject({ status: "searchable", stats: { embedded: 0 } })
    expect(result.after?.embedModel).toBeUndefined()
    expect(result.vectors?.count).toBe(0)
    expect(result.recalled.text).toContain("The audit log keeps entries for 7 years.")
  }, 60_000)

  // `vector memory model remove` is a process of its own that exits once the model is gone, before any background
  // embedder of its own would run: removeModel deletes the vectors before it returns.
  test("removeModel deletes the vectors at once, in a process that never started the background embedder", async () => {
    await using tmp = await tmpdir()
    const source = await Fixture.write(path.join(tmp.path, "source"))
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(root, { recursive: true })
    const place = placeFor(root)
    const options = {
      file: path.join(tmp.path, "brain.db"),
      dir: tmp.path,
      worker: BrainWorker.layerInline,
      embed: fixtureModel(),
    }
    const count = sql`SELECT count(*) AS count FROM brain_vector`
    const ready = await Effect.runPromise(
      services(
        place,
        (setup) =>
          Effect.gen(function* () {
            yield* setup.embed.install(source)
            const kept = yield* added(setup, text("Audit.md", AUDIT))
            yield* setup.knowledge.wait(setup.place, kept.document!.id, "ready", 20_000)
            return yield* setup.db.get<{ count: number }>(count)
          }),
        options,
      ),
    )
    // Removing the files alone, as the command did, leaves every vector behind in such a process.
    const files = await Effect.runPromise(
      services(
        place,
        (setup) =>
          Effect.gen(function* () {
            const status = yield* setup.embed.remove()
            return { status, vectors: yield* setup.db.get<{ count: number }>(count) }
          }),
        options,
      ),
    )
    const removed = await Effect.runPromise(
      services(
        place,
        (setup) =>
          Effect.gen(function* () {
            const status = yield* setup.knowledge.removeModel()
            return {
              status,
              vectors: yield* setup.db.get<{ count: number }>(count),
              documents: yield* setup.db.all<{ status: string; embed_model: string | null }>(
                sql`SELECT status, embed_model FROM brain_document`,
              ),
            }
          }),
        options,
      ),
    )
    expect(ready?.count).toBeGreaterThan(0)
    expect(files.status.state).toBe("absent")
    expect(files.vectors?.count).toBe(ready?.count)
    expect(removed.status.state).toBe("absent")
    expect(removed.vectors?.count).toBe(0)
    expect(removed.documents).toEqual([{ status: "searchable", embed_model: null }])
  }, 60_000)
})
