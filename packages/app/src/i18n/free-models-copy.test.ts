import { expect, test } from "bun:test"
import { dict as en } from "./en"

// Vector has repositories and the workspace's agents, never "projects" (Vercel's and Supabase's keep the word).
test("the free-model start flow says repository, never project", () => {
  const copy = Object.entries(en).filter(([key]) => key.startsWith("freeModels."))
  expect(copy.length).toBeGreaterThan(0)
  expect(copy.filter(([, text]) => /\bprojects?\b/i.test(text))).toEqual([])
  expect(en["freeModels.start.readyForProject"]).toContain("Open a repository")
})
