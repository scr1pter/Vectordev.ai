#!/usr/bin/env bun
// Offline benchmark of the real ToolOutputStore.bound service, including managed-file writes.
// Run before and after a change with the same Bun version and machine:
//   bun script/agent-eval/output-bound.ts --out /tmp/output-bound.json
// Each case runs in a fresh child process. RSS is a process high-water mark, not allocation profiling.

import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dir, "../..")
const sourceFile = new URL("../../packages/core/src/tool-output-store.ts", import.meta.url)
const sizes = [4 * 1024, 64 * 1024, 1024 * 1024, 4 * 1024 * 1024]
const cases = ["ascii", "unicode"].flatMap((encoding) =>
  sizes.map((bytes) => ({ id: `${encoding}-${bytes}`, encoding, bytes })),
)
const value = (name: string) => process.argv[process.argv.indexOf(`--${name}`) + 1]
const samples = process.argv.includes("--samples") ? Number(value("samples")) : 7
const warmup = process.argv.includes("--warmup") ? Number(value("warmup")) : 1
if (!Number.isInteger(samples) || samples < 1 || !Number.isInteger(warmup) || warmup < 0)
  throw new Error("--samples must be a positive integer and --warmup a nonnegative integer")

if (process.argv.includes("--worker")) {
  const selected = cases.find((entry) => entry.id === value("worker"))
  if (!selected) throw new Error("Unknown benchmark case")
  const root = await mkdtemp(join(tmpdir(), "vector-output-bound-"))
  process.env.XDG_DATA_HOME = join(root, "xdg-data")
  process.env.XDG_CACHE_HOME = join(root, "xdg-cache")
  process.env.XDG_CONFIG_HOME = join(root, "xdg-config")
  process.env.XDG_STATE_HOME = join(root, "xdg-state")
  process.env.VECTOR_TEST_HOME = root

  try {
    const measuredSourceSha256 = await sourceDigest()
    // Resolve from Core so filtered workspace installs are sufficient for this benchmark.
    const { Effect } = (await import(
      import.meta.resolve("effect", new URL("../../packages/core/package.json", import.meta.url).href)
    )) as typeof import("effect")
    const { LayerNode } = await import("../../packages/core/src/effect/layer-node")
    const { Global } = await import("../../packages/core/src/global")
    const { FSUtil } = await import("../../packages/core/src/fs-util")
    const { SessionSchema } = await import("../../packages/core/src/session/schema")
    const { ToolOutputStore } = await import("../../packages/core/src/tool-output-store")
    const layer = LayerNode.compile(LayerNode.group([ToolOutputStore.nodeWithoutConfig, FSUtil.node]), [
      [Global.node, Global.layerWith({ data: root })],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ToolOutputStore.Service
        const fs = yield* FSUtil.Service
        const unit = selected.encoding === "ascii" ? "a" : "é界🦄"
        const bodyBytes = selected.bytes - 10
        const unitBytes = Buffer.byteLength(unit)
        const text = `HEAD:${unit.repeat(Math.floor(bodyBytes / unitBytes))}${"x".repeat(bodyBytes % unitBytes)}:TAIL`
        const output = { structured: { kind: "benchmark" }, content: [{ type: "text" as const, text }] }
        const elapsed: number[] = []
        const hashes = new Set<string>()
        Bun.gc(true)
        const rssBefore = process.memoryUsage().rss
        const maxRssBefore = process.resourceUsage().maxRSS * 1024
        for (let index = 0; index < warmup + samples; index++) {
          const start = performance.now()
          const bounded = yield* store.bound({
            sessionID: SessionSchema.ID.make("ses_output_bound_benchmark"),
            toolCallID: `call-${index}`,
            output,
          })
          const duration = performance.now() - start
          if (index >= warmup) elapsed.push(duration)
          const preview = bounded.output.content[0]
          if (preview?.type !== "text" || Buffer.byteLength(preview.text) > ToolOutputStore.MAX_BYTES)
            throw new Error("Invalid bounded provider output")
          if (!preview.text.startsWith("HEAD:") || !preview.text.endsWith(":TAIL"))
            throw new Error("Head or tail was lost")
          if (bounded.output.structured !== output.structured) throw new Error("Structured metadata was lost")
          if (bounded.outputPaths.length !== (selected.bytes > ToolOutputStore.MAX_BYTES ? 1 : 0))
            throw new Error("Unexpected managed-file retention")
          const normalized = bounded.outputPaths[0]
            ? preview.text.replace(bounded.outputPaths[0], "<managed-output>")
            : preview.text
          hashes.add(createHash("sha256").update(normalized).digest("hex"))
          if (index === warmup + samples - 1 && bounded.outputPaths[0]) {
            // Sample memory before reading the retained file back into the process.
            const rssAfter = process.memoryUsage().rss
            const maxRssAfter = process.resourceUsage().maxRSS * 1024
            if ((yield* fs.readFileString(bounded.outputPaths[0])) !== text)
              throw new Error("Complete retained output differs from the source")
            yield* fs.remove(bounded.outputPaths[0])
            return { elapsed, hashes: [...hashes], rssBefore, rssAfter, maxRssBefore, maxRssAfter }
          }
          if (bounded.outputPaths[0]) yield* fs.remove(bounded.outputPaths[0])
        }
        return {
          elapsed,
          hashes: [...hashes],
          rssBefore,
          rssAfter: process.memoryUsage().rss,
          maxRssBefore,
          maxRssAfter: process.resourceUsage().maxRSS * 1024,
        }
      }).pipe(Effect.provide(layer)),
    )
    if (result.hashes.length !== 1) throw new Error("Provider preview changed across equivalent calls")
    const sorted = result.elapsed.toSorted((a, b) => a - b)
    console.log(
      JSON.stringify({
        ...selected,
        measuredSourceSha256,
        samples,
        warmup,
        elapsedMs: result.elapsed,
        medianMs: sorted[Math.floor(sorted.length / 2)],
        minMs: sorted[0],
        maxMs: sorted.at(-1),
        previewSha256: result.hashes[0],
        rssBeforeBytes: result.rssBefore,
        rssAfterBytes: result.rssAfter,
        peakRssBytes: result.maxRssAfter,
        peakRssBeforeBytes: result.maxRssBefore,
      }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
} else {
  const selected = process.argv.includes("--case") ? cases.filter((entry) => entry.id === value("case")) : cases
  if (selected.length === 0) throw new Error("Unknown benchmark case")
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repositoryRoot })
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repositoryRoot })
  if (commit.exitCode !== 0 || status.exitCode !== 0) throw new Error("Cannot capture repository provenance")
  const provenance = {
    capturedAt: new Date().toISOString(),
    repositoryCommit: commit.stdout.toString().trim(),
    workingTreeDirty: status.stdout.length > 0,
    toolOutputStoreSourceSha256: await sourceDigest(),
  }
  const results = []
  for (const entry of selected) {
    const child = Bun.spawn(
      [
        process.execPath,
        import.meta.path,
        "--worker",
        entry.id,
        "--samples",
        String(samples),
        "--warmup",
        String(warmup),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(`${entry.id} failed: ${stderr || stdout}`)
    const result = JSON.parse(stdout)
    if (result.measuredSourceSha256 !== provenance.toolOutputStoreSourceSha256)
      throw new Error("Measured ToolOutputStore source changed during the benchmark")
    results.push(result)
  }
  if ((await sourceDigest()) !== provenance.toolOutputStoreSourceSha256)
    throw new Error("ToolOutputStore source changed during the benchmark")
  const report = {
    benchmark: "ToolOutputStore.bound",
    provenance,
    bunVersion: Bun.version,
    platform: `${process.platform}-${process.arch}`,
    timing: "Warm service calls including real managed-file writes; input generation and validation excluded.",
    memory:
      "Fresh child per case. RSS includes imports, service setup, input, allocator and file-write buffers. Peak RSS is a process high-water mark; it is not retained memory or isolated suffix allocation.",
    results,
  }
  if (process.argv.includes("--out")) await Bun.write(value("out"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report, null, 2))
}

async function sourceDigest() {
  return createHash("sha256")
    .update(await Bun.file(sourceFile).text())
    .digest("hex")
}
