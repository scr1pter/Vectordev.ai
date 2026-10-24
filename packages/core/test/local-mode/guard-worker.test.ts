import { expect, test } from "bun:test"
import path from "node:path"
import { bundle } from "../brain/fixture/bundle"
import { tmpdir } from "../fixture/tmpdir"

test.each(["bun-eval", "node-eval", "node-data"])(
  "a bundled guard loads in a %s worker and refuses a child with no valid preload",
  async (mode) => {
    await using tmp = await tmpdir()
    const entry = path.join(tmp.path, "entry.ts")
    await Bun.write(
      entry,
      `import ${JSON.stringify(path.join(import.meta.dir, "../../src/local-mode/backstop-worker.ts"))}
import { EgressGuard } from ${JSON.stringify(path.join(import.meta.dir, "../../src/local-mode/guard.ts"))}
import threads from "node:worker_threads"
const blocked = await fetch("http://198.51.100.7", { signal: AbortSignal.timeout(500) })
  .then(() => "allowed", (error) => error.name)
const nested = await Promise.resolve()
  .then(() => new threads.Worker("setInterval(() => {}, 1000)", { eval: true }))
  .then(async (worker) => { await worker.terminate(); return "started" }, (error) => error.message)
threads.parentPort.postMessage({ installed: EgressGuard.installed(), blocked, nested })`,
    )
    const source = path.join(tmp.path, "guard.mjs")
    await Bun.write(source, await bundle(entry))
    const driver = path.join(tmp.path, "driver.mjs")
    await Bun.write(
      driver,
      `import { readFileSync } from "node:fs"
import { Worker } from "node:worker_threads"
const source = readFileSync(process.argv[2], "utf8")
const worker = process.argv[3] === "node-data"
  ? new Worker(new URL("data:text/javascript;base64," + Buffer.from(source).toString("base64")))
  : new Worker(source, { eval: true, execArgv: [] })
try {
  const result = await new Promise((resolve, reject) => {
    worker.once("message", resolve)
    worker.once("error", reject)
  })
  process.stdout.write(JSON.stringify(result))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await worker.terminate()
}`,
    )
    const child = Bun.spawn([mode === "bun-eval" ? process.execPath : "node", driver, source, mode], {
      cwd: tmp.path,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    const result = JSON.parse(stdout)
    expect(result).toMatchObject({ installed: true, blocked: "EgressBlocked" })
    expect(result.nested).toMatch(/preload|Invalid URL|File URL/)
  },
  60_000,
)
