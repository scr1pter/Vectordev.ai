import { expect, test } from "bun:test"
import path from "node:path"
import { dict as en } from "./en"

// Vector has repositories and the workspace's agents, never "projects" (Vercel's and Supabase's keep the word).
test("the free-model start flow says repository, never project", () => {
  const copy = Object.entries(en).filter(([key]) => key.startsWith("freeModels."))
  expect(copy.length).toBeGreaterThan(0)
  expect(copy.filter(([, text]) => /\bprojects?\b/i.test(text))).toEqual([])
})

// Copy nobody shows drifts from the owner's rules unseen, as the first-run card's old "ready" and "unavailable"
// strings did once the card moved to a Vector sign-in.
test("every free-model string is shown somewhere in the app", async () => {
  const source = await Promise.all(
    [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: path.join(import.meta.dir, "..") })]
      .filter((file) => !file.startsWith("i18n/"))
      .map((file) => Bun.file(path.join(import.meta.dir, "..", file)).text()),
  )
  const keys = Object.keys(en).filter((key) => key.startsWith("freeModels."))
  expect(keys.filter((key) => !source.some((text) => text.includes(`"${key}"`)))).toEqual([])
})

test("a build that cannot sign in to Vector itself says where to sign in, without offering a sign-in", () => {
  expect(en["freeModels.start.signInEngine"]).toContain("run vector login")
  expect(en["freeModels.start.signInEngine"]).not.toMatch(/openrouter/i)
})
