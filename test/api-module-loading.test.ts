import { expect, test } from "bun:test"
import path from "node:path"

// Vercel runs each api/ function on Node after compiling the TypeScript files it reaches by relative path. A runtime
// import by workspace package name resolves to that package's TypeScript source inside node_modules, which Node will not
// load: every free-model route returned 500 in production because of one such import (17 October 2026). Bun runs
// TypeScript anywhere, so the source tests alone cannot catch it.
const root = path.join(import.meta.dir, "..")
const transpiler = new Bun.Transpiler({ loader: "ts" })

async function resolve(from: string, specifier: string) {
  const base = path.resolve(path.dirname(from), specifier)
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")]) {
    if (await Bun.file(candidate).exists()) return candidate
  }
  throw new Error(`${path.relative(root, from)} imports ${specifier}, which does not resolve to a file`)
}

test("api functions reach other workspace packages only through relative imports", async () => {
  const entries = Array.from(new Bun.Glob("api/**/*.ts").scanSync({ cwd: root }))
    .filter((file) => !file.endsWith(".test.ts"))
    .map((file) => path.join(root, file))
  expect(entries.length).toBeGreaterThan(10)
  const seen = new Set<string>()
  const queue = [...entries]
  const packageImports: string[] = []
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    // scanImports leaves out type-only imports, which the compiler erases.
    for (const item of transpiler.scanImports(await Bun.file(file).text())) {
      if (item.path.startsWith(".")) queue.push(await resolve(file, item.path))
      else if (item.path.startsWith("@vectordevai/")) packageImports.push(`${path.relative(root, file)} -> ${item.path}`)
    }
  }
  expect(seen.size).toBeGreaterThan(entries.length)
  expect(packageImports).toEqual([])
})
