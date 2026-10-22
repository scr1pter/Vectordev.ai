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
  // The composer card, and the Getting Started step and the send-without-model toast beside it.
  for (const key of ["freeModels.start.signInEngine", "prompt.toast.providerRequired.descriptionEngine"] as const) {
    expect(en[key]).toContain("run vector login")
    expect(en[key]).toContain("on the computer this page connects to")
    expect(en[key]).not.toMatch(/openrouter/i)
  }
})

// Owner, 22 October 2026: included models never name OpenRouter in the app. A connected OpenRouter account of the
// user's own is still named where it is the one that runs ("Continue with connected OpenRouter").
test("free-model copy about the included models never names OpenRouter", () => {
  const own = ["freeModels.limit.resume", "freeModels.limit.resumed"]
  const copy = Object.entries(en).filter(([key]) => key.startsWith("freeModels.") && !own.includes(key))
  expect(copy.filter(([, text]) => /openrouter/i.test(text))).toEqual([])
})
