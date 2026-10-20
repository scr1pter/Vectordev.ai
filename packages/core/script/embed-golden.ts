#!/usr/bin/env bun
// Pins the vectors every load of a search model is checked against (src/brain/embed-golden.json).
//
// It reads a model's files from a folder in the layout of its Hugging Face repository (onnx/model_quantized.onnx,
// tokenizer.json, tokenizer_config.json), refuses any file whose size or sha256 is not the one the manifest pins,
// embeds the canary sentences through the same code the background reader runs (ONNX Runtime's WASM build on one
// thread), does it again under Node from a bundle of this script, and writes the vectors only when both runtimes agree.
// It downloads nothing: fetch the pinned files first (see the manifest's revision and sizes).
//
//   bun script/embed-golden.ts <model folder> [--model arctic-embed-xs-q8] [--variant int8|fp32]
//   bun script/embed-golden.ts <model folder> --check        compare with the pinned vectors, write nothing

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BrainEmbedManifest } from "../src/brain/embed-manifest"
import { BrainWorkerEmbed } from "../src/brain/worker/embed"

const GOLDEN = path.join(import.meta.dirname, "..", "src", "brain", "embed-golden.json")
/** How closely Bun's and Node's vectors must agree: the same wasm should give the same floats. */
const AGREE = 0.9999

type Vectors = { readonly text: string; readonly role: "query" | "passage"; readonly vector: number[] }[]

if (process.argv[2] === "--node") {
  const [dir, wasm, id, variant] = process.argv.slice(3)
  const vectors = await canaries(
    dir!,
    wasm!,
    BrainEmbedManifest.MODELS[id as BrainEmbedManifest.ModelID],
    variant as BrainEmbedManifest.Variant,
  )
  process.stdout.write(`${JSON.stringify(vectors)}\n`)
} else if (import.meta.main) await main()

async function main() {
  const args = process.argv.slice(2)
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const dir = args.find((arg) => !arg.startsWith("--") && arg !== flag("--model") && arg !== flag("--variant"))
  if (!dir) throw new Error("Name the folder that holds the model's files.")
  const id = (flag("--model") ?? BrainEmbedManifest.DEFAULT) as BrainEmbedManifest.ModelID
  const model = BrainEmbedManifest.MODELS[id]
  if (!model) throw new Error(`No model ${id} in the manifest.`)
  const variant = (flag("--variant") ?? "int8") as BrainEmbedManifest.Variant
  for (const file of BrainEmbedManifest.files(model, variant)) {
    const bytes = await fs.readFile(path.join(dir, file.name)).catch(() => undefined)
    if (!bytes) throw new Error(`${dir} has no ${file.name}.`)
    if (bytes.byteLength !== file.bytes)
      throw new Error(`${file.name} is ${bytes.byteLength} bytes, not the pinned ${file.bytes}.`)
    const digest = createHash("sha256").update(bytes).digest("hex")
    if (file.sha256 && digest !== file.sha256)
      throw new Error(`${file.name} has sha256 ${digest}, not the pinned ${file.sha256}.`)
    console.log(
      `${file.name}: ${file.bytes} bytes, sha256 ${digest}${file.sha256 ? "" : " (not pinned yet: pin it in the manifest)"}`,
    )
  }
  const wasm = fileURLToPath(import.meta.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm"))
  const bun = await canaries(dir, wasm, model, variant)
  const node = await underNode(dir, wasm, model, variant)
  const agreement = bun.map((item, index) => cosine(item.vector, node[index]!.vector))
  console.log(
    `Bun ${Bun.version} and Node agree on the canaries: ${agreement.map((value) => value.toFixed(6)).join(", ")}`,
  )
  if (agreement.some((value) => value < AGREE))
    throw new Error("Bun and Node gave different vectors; nothing was written.")
  const pinned: Record<string, { revision: string; int8?: Vectors; fp32?: Vectors }> = JSON.parse(
    await fs.readFile(GOLDEN, "utf8"),
  )
  if (args.includes("--check")) {
    const entry = pinned[id]
    const against = variant === "fp32" ? (entry?.fp32 ?? entry?.int8) : entry?.int8
    if (!entry || entry.revision !== model.revision || !against)
      throw new Error(`No pinned vectors for ${id} at ${model.revision}.`)
    const matches = bun.map((item, index) => cosine(item.vector, against[index]!.vector))
    console.log(`Against the pinned vectors: ${matches.map((value) => value.toFixed(6)).join(", ")}`)
    return
  }
  const rounded = bun.map((item) => ({ ...item, vector: item.vector.map((value) => Number(value.toFixed(7))) }))
  const next = {
    ...pinned,
    [id]: {
      ...(pinned[id]?.revision === model.revision ? pinned[id] : {}),
      revision: model.revision,
      [variant]: rounded,
    },
  }
  // One canary's vector on one line, so the file reads as three sentences and their numbers.
  const text = JSON.stringify(next, (key, value) => (key === "vector" ? JSON.stringify(value) : value), 2).replace(
    /"vector": "(\[[^"]*\])"/g,
    '"vector": $1',
  )
  await fs.writeFile(GOLDEN, `${text}\n`)
  console.log(
    `Wrote ${bun.length} ${variant} canary vectors of ${model.dims} dimensions for ${id}@${model.revision} to ${GOLDEN}`,
  )
}

// The canaries' vectors through the background reader's own code.
async function canaries(
  dir: string,
  wasm: string,
  model: BrainEmbedManifest.Model,
  variant: BrainEmbedManifest.Variant,
): Promise<Vectors> {
  const graph = BrainEmbedManifest.files(model, variant)[0]!
  const data = variant === "int8" ? model.files.data : undefined
  await BrainWorkerEmbed.load({
    id: 1,
    type: "load",
    key: BrainEmbedManifest.key(model, variant),
    wasm: new Uint8Array(await fs.readFile(wasm)),
    model: new Uint8Array(await fs.readFile(path.join(dir, graph.name))),
    ...(data
      ? { data: new Uint8Array(await fs.readFile(path.join(dir, data.name))), dataName: path.basename(data.name) }
      : {}),
    tokenizer: await fs.readFile(path.join(dir, model.files.tokenizer.name), "utf8"),
    config: await fs.readFile(path.join(dir, model.files.config.name), "utf8"),
    settings: {
      dims: model.dims,
      pooling: model.pooling,
      maxTokens: model.maxTokens,
      queryTokens: model.queryTokens,
      query: model.query,
    },
    canaries: [],
  })
  const out: Vectors = []
  for (const canary of BrainEmbedManifest.CANARIES) {
    const result = await BrainWorkerEmbed.embed({
      id: 2,
      type: "embed",
      key: BrainEmbedManifest.key(model, variant),
      texts: [canary.text],
      role: canary.role,
    })
    out.push({ text: canary.text, role: canary.role, vector: Array.from(result.vectors) })
  }
  return out
}

// The same canaries under Node, from this script bundled for it, so a vector pinned here holds on both runtimes.
async function underNode(
  dir: string,
  wasm: string,
  model: BrainEmbedManifest.Model,
  variant: BrainEmbedManifest.Variant,
) {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vector-embed-golden-"))
  try {
    const built = await Bun.build({ entrypoints: [import.meta.path], target: "node", format: "esm", outdir: out })
    if (!built.success) throw new AggregateError(built.logs, "The Node check could not be built")
    const result = spawnSync("node", [built.outputs[0]!.path, "--node", dir, wasm, model.id, variant], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
    if (result.status !== 0) throw new Error(`The Node check failed: ${result.stderr}`)
    console.log(
      `Node ${spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim()} embedded the canaries too.`,
    )
    return JSON.parse(result.stdout) as Vectors
  } finally {
    await fs.rm(out, { recursive: true, force: true })
  }
}

function cosine(a: readonly number[], b: readonly number[]) {
  const dot = a.reduce((sum, value, index) => sum + value * b[index]!, 0)
  const norms = Math.sqrt(
    a.reduce((sum, value) => sum + value * value, 0) * b.reduce((sum, value) => sum + value * value, 0),
  )
  return norms > 0 ? dot / norms : 0
}
