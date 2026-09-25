import { expect, test } from "bun:test"
import path from "node:path"

test("model prompts permit Vector identity and its own documentation", async () => {
  const root = path.resolve(import.meta.dir, "../../../..")
  const prompts = Array.from(new Bun.Glob("*.txt").scanSync(path.join(root, "packages/engine/src/session/prompt")))
  expect(prompts.length).toBeGreaterThanOrEqual(9)
  const files = [
    ...prompts.map((file) => `packages/engine/src/session/prompt/${file}`),
    "packages/engine/src/session/system.ts",
    "packages/core/src/plugin/agent.ts",
  ]
  for (const file of files) {
    const content = await Bun.file(path.join(root, file)).text()
    expect(content, file).not.toMatch(/(?:do not call yourself|never identify yourself as)[^.\n]*\bvector\b/i)
    expect(content, file).not.toMatch(/do not (?:browse|direct the user to)[^.\n]*\bvector(?:-branded)?\b/i)
  }
})
