import { expect, test } from "bun:test"
import path from "node:path"
import { parseTree } from "jsonc-parser"

const root = path.resolve(import.meta.dir, "../../../..")

function unsafeExamples(content: string) {
  return [...content.matchAll(/["']plugin["']\s*:\s*(?=\[)/g)].flatMap((match) => {
    const tree = parseTree(content.slice(match.index + match[0].length))
    return (tree?.type === "array" ? (tree.children ?? []) : []).flatMap((entry) => {
      const specifier = entry.type === "array" ? entry.children?.[0]?.value : entry.value
      return typeof specifier === "string" && /^vector-[a-z0-9-]+(?:@|$)/.test(specifier) ? [specifier] : []
    })
  })
}

test("plugin example scan detects inline and tuple package specs, including JSONC snippets", () => {
  expect(unsafeExamples('{ "plugin": ["vector-unowned-auth", ["vector-other@1.0.0", {}]] }')).toEqual([
    "vector-unowned-auth",
    "vector-other@1.0.0",
  ])
  expect(unsafeExamples('```jsonc\n{"plugin":[// example\n"vector-example"]}\n```')).toEqual(["vector-example"])
  expect(
    unsafeExamples('{"plugin":["./vector-example.ts", "file:///tmp/vector-example.js", "@vectordevai/plugin"]}'),
  ).toEqual([])
})

test("built-in skills and docs do not suggest unowned unscoped Vector plugin packages", async () => {
  const violations: string[] = []
  for (const pattern of ["packages/core/src/plugin/skill/*.md", "packages/web/src/pages/docs/**/*"]) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
      const content = await Bun.file(path.join(root, file)).text()
      violations.push(...unsafeExamples(content).map((specifier) => `${file}: ${specifier}`))
    }
  }
  expect(violations).toEqual([])
})
