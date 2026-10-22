import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BrainEmbed } from "@vectordevai/core/brain/embed"
import { BrainEmbedManifest } from "@vectordevai/core/brain/embed-manifest"
import { BrainWorker } from "@vectordevai/core/brain/worker/host"
import { Global } from "@vectordevai/core/global"
import { tmpdir } from "../fixture/tmpdir"
import { added, text, withKnowledge } from "./fixture/knowledge"
import * as Fixture from "./fixture/onnx"

// Downloading the search model, from a server on 127.0.0.1 that plays Vector's copy (/mirror) and Hugging Face (/hf)
// with the fixture model's files: what is refused, what is resumed, and that nothing after the download needs the
// network. Tests never reach the internet.

type Handler = (request: IncomingMessage, response: ServerResponse, file: Uint8Array | undefined, name: string) => void

const FILES = Fixture.files()

/** The fixture's files by the URL paths the two sources ask for, and every request made. */
async function serve(handler?: Handler) {
  const requests: { url: string; range?: string }[] = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", ...(request.headers.range ? { range: request.headers.range } : {}) })
    const url = request.url ?? ""
    const name = url.startsWith("/hf/")
      ? url.slice(4)
      : Object.keys(FILES).find(
          (file) => url === `/mirror/${BrainEmbedManifest.asset(Fixture.manifest(), { name: file, bytes: 0 })}`,
        )
    const file = name ? FILES[name as keyof typeof FILES] : undefined
    if (handler) return handler(request, response, file, name ?? "")
    send(request, response, file)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  return { base, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/** A file whole, or from the byte a Range header asks for. */
function send(request: IncomingMessage, response: ServerResponse, file: Uint8Array | undefined) {
  if (!file) {
    response.writeHead(404).end()
    return
  }
  const start = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1] ?? 0)
  if (start > 0) {
    response.writeHead(206, {
      "content-range": `bytes ${start}-${file.byteLength - 1}/${file.byteLength}`,
      "content-length": file.byteLength - start,
    })
    response.end(file.subarray(start))
    return
  }
  response.writeHead(200, { "content-length": file.byteLength })
  response.end(file)
}

function sources(base: string): BrainEmbed.Source[] {
  return [
    {
      name: "mirror",
      url: (model, file) => (file.sha256 ? `${base}/mirror/${BrainEmbedManifest.asset(model, file)}` : undefined),
      hosts: ["127.0.0.1"],
    },
    { name: "huggingface", url: (_, file) => `${base}/hf/${file.name}`, hosts: ["127.0.0.1"] },
  ]
}

function pinned(): BrainEmbed.Golden {
  return {
    "arctic-embed-xs-q8": {
      revision: Fixture.manifest().revision,
      int8: BrainEmbedManifest.CANARIES.map((canary) => ({
        text: canary.text,
        role: canary.role,
        vector: Array.from(Fixture.expected(canary.text)),
      })),
    },
  }
}

function layerFor(
  dir: string,
  options: Partial<BrainEmbed.Options> & { readonly fetch?: typeof globalThis.fetch } = {},
) {
  const { fetch, ...rest } = options
  return BrainEmbed.layerWith({
    dir,
    models: { "arctic-embed-xs-q8": Fixture.manifest() },
    golden: pinned(),
    downloads: true,
    ...rest,
  }).pipe(
    Layer.provide(
      fetch
        ? FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
        : FetchHttpClient.layer,
    ),
    Layer.provide(BrainWorker.layerInline),
    Layer.provide(Layer.succeed(Global.Service, Global.make({ data: path.join(dir, "data") }))),
  )
}

async function download(options: { readonly handler?: Handler; readonly extra?: Partial<BrainEmbed.Options> } = {}) {
  await using tmp = await tmpdir()
  const server = await serve(options.handler)
  const dir = path.join(tmp.path, "models")
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const embed = yield* BrainEmbed.Service
        const outcome = yield* embed.download().pipe(
          Effect.map((status) => ({ ok: true as const, status })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        )
        return {
          outcome,
          status: yield* embed.status(),
          vectors: yield* embed.embed(["refresh tokens expire after days"]),
        }
      }).pipe(Effect.provide(layerFor(dir, { sources: sources(server.base), ...options.extra }))),
    )
    return { ...result, requests: server.requests, files: await listed(dir), dir }
  } finally {
    await server.close()
  }
}

describe("downloading the search model", () => {
  // The repository is private, so its GitHub releases 404 for users: Vector's copy is the public Blob store the
  // installers come from, and each source's first request must be on a host that source allows.
  test("asks Vector's copy on the public download store first, then Hugging Face at the pinned revision", () => {
    const [mirror, huggingFace] = BrainEmbed.SOURCES
    const arctic = BrainEmbedManifest.MODELS["arctic-embed-xs-q8"]
    const granite = BrainEmbedManifest.MODELS["granite-small-r2-q8"]
    expect(mirror?.name).toBe("mirror")
    expect(mirror?.hosts).toEqual(["42qryducihx01gl0.public.blob.vercel-storage.com"])
    expect(BrainEmbedManifest.files(arctic).map((file) => mirror?.url(arctic, file))).toEqual([
      "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/knowledge-pack-1/arctic-embed-xs-q8-model_quantized.onnx",
      "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/knowledge-pack-1/arctic-embed-xs-q8-tokenizer.json",
      "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/knowledge-pack-1/arctic-embed-xs-q8-tokenizer_config.json",
    ])
    // A file pinned by size only is never taken from the copy.
    expect(mirror?.url(granite, granite.files.tokenizer)).toBeUndefined()
    expect(huggingFace?.name).toBe("huggingface")
    expect(huggingFace?.url(arctic, arctic.files.model)).toBe(
      `https://huggingface.co/Snowflake/snowflake-arctic-embed-xs/resolve/${arctic.revision}/onnx/model_quantized.onnx`,
    )
    for (const source of BrainEmbed.SOURCES)
      for (const model of [arctic, granite])
        for (const file of BrainEmbedManifest.files(model)) {
          const url = source.url(model, file)
          if (url) expect(source.hosts, url).toContain(new URL(url).hostname)
        }
  })

  test("takes the files from Vector's copy first, checks each, writes manifest.json last, and runs offline after", async () => {
    const result = await download()
    expect(result.outcome).toMatchObject({ ok: true, status: { state: "ready", source: "mirror", variant: "int8" } })
    expect(result.requests.map((request) => request.url)).toEqual(
      Object.keys(FILES).map((name) => `/mirror/${BrainEmbedManifest.asset(Fixture.manifest(), { name, bytes: 0 })}`),
    )
    const folder = `arctic-embed-xs-q8@${Fixture.manifest().revision}`
    expect(result.files.map((file) => path.relative(result.dir, file)).toSorted()).toEqual(
      [
        path.join(folder, "manifest.json"),
        path.join(folder, "onnx", "model_quantized.onnx"),
        path.join(folder, "tokenizer.json"),
        path.join(folder, "tokenizer_config.json"),
        "settings.json",
      ].toSorted(),
    )
    expect(result.vectors).toHaveLength(1)
  }, 60_000)

  test("goes to Hugging Face for a file the copy does not have or gives wrong", async () => {
    const result = await download({
      handler: (request, response, file, name) => {
        const url = request.url ?? ""
        if (url.startsWith("/mirror/") && name === "tokenizer.json") return response.writeHead(404).end()
        if (url.startsWith("/mirror/") && name === "tokenizer_config.json" && file)
          return send(request, response, tamper(file))
        send(request, response, file)
      },
    })
    expect(result.outcome).toMatchObject({ ok: true, status: { state: "ready" } })
    expect(result.requests.map((request) => request.url)).toEqual([
      `/mirror/arctic-embed-xs-q8-model_quantized.onnx`,
      `/mirror/arctic-embed-xs-q8-tokenizer.json`,
      `/hf/tokenizer.json`,
      `/mirror/arctic-embed-xs-q8-tokenizer_config.json`,
      `/hf/tokenizer_config.json`,
    ])
  }, 60_000)

  test("refuses a file with one byte changed, and leaves no .part behind", async () => {
    const result = await download({
      handler: (request, response, file, name) =>
        send(request, response, name === "onnx/model_quantized.onnx" && file ? tamper(file) : file),
    })
    expect(result.outcome.ok).toBe(false)
    expect(!result.outcome.ok && result.outcome.error.reason).toBe("verify")
    expect(!result.outcome.ok && result.outcome.error.message).toContain("sha256")
    expect(result.status).toMatchObject({ state: "absent" })
    expect(result.status.error).toContain("model_quantized.onnx")
    expect(result.files.filter((file) => file.endsWith(".part") || file.endsWith("manifest.json"))).toEqual([])
    expect(result.vectors).toBeUndefined()
  }, 60_000)

  test("stops a file that grows past its pinned size, and leaves no .part behind", async () => {
    const result = await download({
      handler: (request, response, file, name) => {
        if (name !== "tokenizer.json" || !file) return send(request, response, file)
        response.writeHead(200)
        response.end(Buffer.concat([Buffer.from(file), Buffer.alloc(4096, 32)]))
      },
    })
    expect(!result.outcome.ok && result.outcome.error.reason).toBe("size")
    expect(result.files.filter((file) => file.endsWith(".part") || file.endsWith("manifest.json"))).toEqual([])
  }, 60_000)

  test("resumes a cut download from where it stopped, with an HTTP range", async () => {
    const cut = { done: false }
    const graph = FILES["onnx/model_quantized.onnx"]
    const result = await download({
      handler: (request, response, file, name) => {
        if (name === "onnx/model_quantized.onnx" && !cut.done) {
          cut.done = true
          response.writeHead(200, { "content-length": graph.byteLength })
          response.write(graph.subarray(0, 2_000), () => setTimeout(() => response.destroy(), 20))
          return
        }
        send(request, response, file)
      },
    })
    expect(result.outcome).toMatchObject({ ok: true, status: { state: "ready" } })
    // How much of the cut reaches the disk, and whether a retry is cut again, depends on the runner's load (a
    // loaded CI runner once made a third request), so the check is that the next request resumes with a range.
    const asked = result.requests.filter((request) => request.url.endsWith("model_quantized.onnx"))
    expect(asked.length).toBeGreaterThanOrEqual(2)
    const start = Number(/^bytes=(\d+)-$/.exec(asked[1]!.range ?? "")?.[1])
    expect(start).toBeGreaterThan(0)
    expect(start).toBeLessThanOrEqual(2_000)
  }, 60_000)

  test("refuses a redirect to a host the source does not use", async () => {
    const result = await download({
      handler: (request, response, file) => {
        if ((request.url ?? "").includes("model_quantized")) {
          response.writeHead(302, { location: "http://downloads.example.invalid/model_quantized.onnx" }).end()
          return
        }
        send(request, response, file)
      },
    })
    expect(!result.outcome.ok && result.outcome.error.reason).toBe("host")
    expect(!result.outcome.ok && result.outcome.error.message).toContain("downloads.example.invalid")
    expect(result.status.state).toBe("absent")
  }, 60_000)

  test("follows a redirect within the source's hosts, as Hugging Face's CDN is", async () => {
    const result = await download({
      handler: (request, response, file) => {
        const url = request.url ?? ""
        if (url.startsWith("/mirror/arctic-embed-xs-q8-model_quantized.onnx")) {
          response.writeHead(302, { location: "/cdn/model_quantized.onnx" }).end()
          return
        }
        if (url === "/cdn/model_quantized.onnx") return send(request, response, FILES["onnx/model_quantized.onnx"])
        send(request, response, file)
      },
    })
    expect(result.outcome).toMatchObject({ ok: true, status: { state: "ready" } })
    expect(result.requests.map((request) => request.url)).toContain("/cdn/model_quantized.onnx")
  }, 60_000)

  test("starts nothing where downloads are off, as in tests and CI, and says to install from a folder", async () => {
    await using tmp = await tmpdir()
    expect(process.env.VECTOR_BRAIN_EMBED).toBe("off")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const embed = yield* BrainEmbed.Service
        return {
          error: yield* embed.download().pipe(Effect.flip),
          started: yield* embed.start(),
          status: yield* embed.status(),
        }
      }).pipe(Effect.provide(layerFor(path.join(tmp.path, "models"), { downloads: undefined }))),
    )
    expect(result.error.reason).toBe("off")
    expect(result.error.message).toContain("Install the model from a folder")
    expect(result.started).toMatchObject({ state: "absent", downloads: false })
    expect(result.status.options?.map((option) => option.id)).toEqual(["arctic-embed-xs-q8", "granite-small-r2-q8"])
  })

  test("once installed, documents are embedded and searched with a fetch that throws", async () => {
    const throwing: typeof globalThis.fetch = Object.assign(
      () => {
        throw new Error("no network after the download")
      },
      { preconnect: () => {} },
    )
    await using tmp = await tmpdir()
    const source = await Fixture.write(path.join(tmp.path, "source"))
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const installed = yield* setup.embed.install(source)
          const kept = yield* added(setup, text("Audit.md", "# Audit\n\nThe audit log keeps logs for years.\n"))
          const ready = yield* setup.knowledge.wait(setup.place, kept.document!.id, "ready", 20_000)
          const found = yield* setup.knowledge.search(setup.place, {
            query: "how long do we keep the audit log",
            personal: true,
          })
          return { installed, ready, found, model: yield* setup.knowledge.model(setup.place) }
        }),
      { embed: (data) => layerFor(path.join(data, "models", "embedding"), { fetch: throwing }) },
    )
    expect(result.installed.state).toBe("ready")
    expect(result.ready?.status).toBe("ready")
    expect(result.ready?.stats.embedded).toBeGreaterThan(0)
    expect(result.found.map((card) => card.text).join(" ")).toContain("audit log keeps logs for years")
    expect(result.model.embedded!.done).toBe(result.model.embedded!.total)
  }, 60_000)
})

function tamper(file: Uint8Array) {
  const copy = new Uint8Array(file)
  copy[copy.length >> 1] ^= 0x01
  return copy
}

async function listed(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? listed(path.join(dir, entry.name)) : [path.join(dir, entry.name)])),
  )
  return nested.flat()
}
