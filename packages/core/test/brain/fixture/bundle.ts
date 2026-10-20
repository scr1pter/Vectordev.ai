import path from "node:path"
import { tmpdir } from "../../fixture/tmpdir"

// Bundles a source for Node as the engine's build bundles the background reader (target node, ESM), in a bun process
// of its own. In a test process where other tests have run, a Bun.build can fail to read files an earlier build read
// ("EAGAIN" or "EINVAL reading file" on Linux, "Unexpected" or "Unseekable reading file" on macOS), and building again
// in that process fails the same way. A fresh process reads them cleanly, and one that still hits a read error on a
// loaded runner is retried. Each source is built once per test process.
const built = new Map<string, Promise<string>>()

export function bundle(entry: string, options: { readonly minify?: boolean } = {}) {
  const key = `${entry}\0${options.minify === true}`
  const source = built.get(key) ?? build(entry, options.minify === true, 1)
  built.set(key, source)
  return source
}

const ATTEMPTS = 3

async function build(entry: string, minify: boolean, attempt: number): Promise<string> {
  await using tmp = await tmpdir()
  const out = path.join(tmp.path, "bundle.mjs")
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      entry,
      "--target=node",
      "--format=esm",
      ...(minify ? ["--minify"] : []),
      `--outfile=${out}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  // Read before the folder is removed, which happens as this function returns.
  if (code === 0) return await Bun.file(out).text()
  if (attempt < ATTEMPTS && /reading file/i.test(stderr)) {
    await Bun.sleep(200 * attempt)
    return build(entry, minify, attempt + 1)
  }
  throw new Error(`bun build ${entry} exited with ${code} after ${attempt} attempts:\n${stderr}${stdout}`)
}
