#!/usr/bin/env bun
// Smoke test for the brain's background reader inside Electron's utility process.
//
// The desktop engine runs in a utility process and starts the reader as an eval worker from source it carries as a
// string, so the app never loads a worker script out of the signed app. Node and the compiled CLI are smoke-tested
// elsewhere (the engine's smoke-node-bundle.ts and verify-brain-worker.ts); this one starts Electron itself, forks a
// utility process the way src/main/server.ts forks the engine, and has it read a generated PDF in the reader with
// core's own host, failing unless the PDF was read in a worker thread. The same worker then runs the search model on
// ONNX Runtime's wasm: the fixture model, whose vectors are known without ONNX Runtime, and with VECTOR_TEST_EMBED_DIR
// (a folder of the pinned arctic-embed-xs files) the real int8 model against its pinned canary vectors, which is where
// an Electron build that computes int8 MatMulInteger wrongly would show. The utility bundle then runs under plain Node
// as well, the same checks on the same code.
//
//   bun scripts/verify-brain-worker.ts                         (the Electron this package installs)
//   ELECTRON_PATH=/path/to/electron bun scripts/verify-brain-worker.ts
//
// It needs a desktop session on macOS and Windows, and a display (or xvfb-run) on Linux, where Electron runs without
// Chromium's sandbox: CI runners cannot set up its helper, and the smoke runs only this script's own code.

import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BrainEmbedManifest } from "../../core/src/brain/embed-manifest"
import golden from "../../core/src/brain/embed-golden.json"
import * as Fixture from "../../core/test/brain/fixture/onnx"
import { lines, pdf } from "../../core/test/brain/fixture/pdf"

const MARK = "brain-worker-smoke "
const desktop = path.resolve(import.meta.dirname, "..")

const electron = process.env.ELECTRON_PATH ?? (await import("electron").then((module) => module.default as unknown as string))
const scratch = await mkdtemp(path.join(os.tmpdir(), "vector-electron-brain-"))
try {
  const outcome = await smoke(scratch)
  if (outcome.failures.length > 0) {
    console.error(`electron brain worker smoke FAILED (${electron}):`)
    for (const failure of outcome.failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  }
  if (outcome.failures.length === 0)
    console.log(
      `electron brain worker smoke passed on Electron ${outcome.versions?.electron} (Node ${outcome.versions?.node}) and plain Node: a utility process read a PDF in the bundled background reader and ran the search model there${process.env.VECTOR_TEST_EMBED_DIR ? ", the fixture and the pinned arctic-embed-xs int8 model" : " (the fixture model)"}`,
    )
} finally {
  await rm(scratch, { recursive: true, force: true })
}

async function smoke(scratch: string) {
  const reader = await Bun.build({
    entrypoints: [path.join(desktop, "../core/src/brain/worker/entry.ts")],
    target: "node",
    format: "esm",
    minify: true,
  })
  if (!reader.success) throw new AggregateError(reader.logs, "The brain worker bundle failed to build")
  const utility = await Bun.build({
    entrypoints: [path.join(desktop, "scripts/brain-worker-utility.ts")],
    target: "node",
    format: "esm",
    outdir: path.join(scratch, "utility"),
    files: { "brain-worker.gen.ts": `export default ${JSON.stringify(await reader.outputs[0]!.text())}` },
  })
  if (!utility.success) throw new AggregateError(utility.logs, "The utility process bundle failed to build")
  const document = path.join(scratch, "spec.pdf")
  await writeFile(
    document,
    pdf({
      pages: [
        {
          runs: [
            { text: "Auth spec", x: 72, y: 740, size: 20, font: "bold" },
            ...lines(["Refresh tokens expire after 14 days."], { top: 700 }),
          ],
        },
        { runs: lines(["Clients MUST retry at most 3 times after a 429 response."]) },
      ],
    }),
  )
  // The models the worker runs after the PDF, each with what its load and its vectors must come to.
  const specs = await models(path.join(scratch, "models"))
  const specFile = path.join(scratch, "models.json")
  await writeFile(specFile, JSON.stringify(specs))
  // Electron's main process: one utility process, as the desktop forks its engine, and its output passed on.
  const main = path.join(scratch, "main.mjs")
  await writeFile(
    main,
    `import { app, utilityProcess } from "electron"
app.dock?.hide()
const timer = setTimeout(() => { console.error("the utility process did not finish in time"); app.exit(3) }, 90_000)
app.whenReady().then(() => {
  const child = utilityProcess.fork(${JSON.stringify(utility.outputs[0]!.path)}, [${JSON.stringify(document)}, ${JSON.stringify(specFile)}], { stdio: "pipe", serviceName: "vector-brain-smoke" })
  child.stdout.on("data", (chunk) => process.stdout.write(chunk))
  child.stderr.on("data", (chunk) => process.stderr.write(chunk))
  child.on("exit", (code) => { clearTimeout(timer); app.exit(code ?? 1) })
})
`,
  )
  await mkdir(path.join(scratch, "user-data"), { recursive: true })
  const { ELECTRON_RUN_AS_NODE: _, ...environment } = process.env
  const flags = [`--user-data-dir=${path.join(scratch, "user-data")}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])]
  const result = spawnSync(electron, [main, ...flags], {
    encoding: "utf8",
    timeout: 120_000,
    env: environment,
  })
  if (result.error) return { failures: [`Electron could not start: ${result.error.message}`] }
  const inElectron = checked(result.stdout, result.stderr, result.status, specs, "Electron")
  // The same bundle under plain Node, as the desktop's engine bundle runs in its smoke and the CLI runs on Bun.
  const node = spawnSync("node", [utility.outputs[0]!.path, document, specFile], { encoding: "utf8", timeout: 120_000 })
  const inNode = node.error
    ? { failures: [`Node could not start: ${node.error.message}`] }
    : checked(node.stdout, node.stderr, node.status, specs, "Node")
  return { failures: [...inElectron.failures, ...inNode.failures.map((failure) => `node: ${failure}`)], versions: inElectron.versions }
}

type Spec = {
  readonly name: string
  readonly key: string
  readonly dir: string
  readonly graph: string
  readonly wasm: string
  readonly settings: { dims: number; pooling: "cls"; maxTokens: number; queryTokens: number; query: string }
  readonly canaries: { text: string; role: "query" | "passage"; vector: number[] }[]
  readonly threshold: number
  readonly texts: readonly string[]
  /** What the texts must embed to, where it is known without ONNX Runtime. */
  readonly expected?: readonly number[][]
}

// The fixture model, written here, and the pinned arctic-embed-xs files when VECTOR_TEST_EMBED_DIR names a folder.
async function models(dir: string): Promise<Spec[]> {
  const wasm = fileURLToPath(import.meta.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm", path.join(desktop, "../core/package.json")))
  await Fixture.write(dir)
  const texts = ["refresh tokens expire after days", "the audit log keeps logs for years"]
  const fixture: Spec = {
    name: "fixture",
    key: "fixture",
    dir,
    graph: "onnx/model_quantized.onnx",
    wasm,
    settings: { dims: Fixture.DIMS, pooling: "cls", maxTokens: 320, queryTokens: 64, query: "" },
    canaries: BrainEmbedManifest.CANARIES.map((canary) => ({ ...canary, vector: Array.from(Fixture.expected(canary.text)) })),
    threshold: BrainEmbedManifest.CHECK,
    texts,
    expected: texts.map((text) => Array.from(Fixture.expected(text))),
  }
  const real = process.env.VECTOR_TEST_EMBED_DIR
  if (!real) return [fixture]
  const model = BrainEmbedManifest.MODELS["arctic-embed-xs-q8"]
  const pinned = (golden as Record<string, { int8: Spec["canaries"] }>)[model.id]!.int8
  return [
    fixture,
    {
      name: "arctic-embed-xs-q8",
      key: BrainEmbedManifest.key(model, "int8"),
      dir: real,
      graph: model.files.model.name,
      wasm,
      settings: { dims: model.dims, pooling: "cls", maxTokens: model.maxTokens, queryTokens: model.queryTokens, query: model.query },
      canaries: pinned,
      threshold: BrainEmbedManifest.CHECK,
      texts: ["Refresh tokens expire after 14 days."],
    },
  ]
}

// What one run of the utility bundle printed, against what it had to do.
function checked(stdout: string, stderr: string, status: number | null, specs: readonly Spec[], runtime: "Electron" | "Node") {
  const line = stdout.split("\n").find((item) => item.startsWith(MARK))
  const summary = line
    ? (JSON.parse(line.slice(MARK.length)) as {
        ok: boolean
        type?: string
        format?: string
        pages?: number
        records?: string[]
        status?: { mode: string; threads: number }
        embedded?: {
          name: string
          vectors?: number[][]
          error?: string
          check?: { key: string; cosines: number[]; passed: boolean }
        }[]
        cause?: string
        versions: Record<string, string>
      })
    : undefined
  if (!summary)
    return { failures: [`the utility process printed no result (exit ${status}):\n${(stdout + stderr).slice(-4_000)}`] }
  if (!summary.ok) return { failures: [`the reader failed: ${summary.cause}`], versions: summary.versions }
  const failures = [
    ...(runtime === "Node" || summary.versions.electron ? [] : ["the reader did not run inside Electron"]),
    ...(summary.type === "extracted" && summary.format === "pdf" && summary.pages === 2
      ? []
      : [`the PDF was not read as two pages: ${JSON.stringify(summary)}`]),
    ...(summary.records?.some((card) => card.includes("retry at most 3 times")) ? [] : ["no record of the retry requirement"]),
    ...(summary.status?.mode === "worker" && summary.status.threads > 0
      ? []
      : [`the reader did not run in a worker thread: ${JSON.stringify(summary.status)}`]),
    ...specs.flatMap((spec) => {
      const ran = summary.embedded?.find((item) => item.name === spec.name)
      if (!ran) return [`${spec.name}: the search model never ran`]
      if (ran.error) return [`${spec.name}: ${ran.error}`]
      if (!ran.check?.passed || ran.check.key !== spec.key)
        return [`${spec.name}: its load failed its check: ${JSON.stringify(ran.check)}`]
      return (spec.expected ?? []).flatMap((vector, index) =>
        cosine(ran.vectors?.[index] ?? [], vector) > 0.9999 ? [] : [`${spec.name}: "${spec.texts[index]}" gave other numbers`],
      )
    }),
  ]
  return { failures, versions: summary.versions }
}

function cosine(a: readonly number[], b: readonly number[]) {
  if (a.length !== b.length) return 0
  const dot = a.reduce((sum, value, index) => sum + value * b[index]!, 0)
  const norms = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0) * b.reduce((sum, value) => sum + value * value, 0))
  return norms > 0 ? dot / norms : 0
}
