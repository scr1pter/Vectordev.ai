import { expect, test } from "bun:test"

// The trust section of the Permissions page, as readers see it: from its heading to the next one, without markup.
async function trustSection() {
  const page = await Bun.file(new URL("../src/pages/docs/permissions.astro", import.meta.url)).text()
  const start = page.indexOf('<h2 id="project-trust">')
  expect(start).toBeGreaterThan(-1)
  const end = page.indexOf("<h2", start + 1)
  return page
    .slice(start, end === -1 ? undefined : end)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
}

test("the Permissions docs describe the one-time repository trust question, not the removed chip", async () => {
  const text = await trustSection()
  expect(text).toContain("Repository trust")
  expect(text).toContain("Trust this repository?")
  expect(text).toContain("Not now")
  // Clones ask like any other repository, so they still cannot raise a spend cap on their own.
  expect(text).toContain("including one you clone")
  expect(text).toContain("a cloned repository cannot raise your spend cap")
  // Spend limits are one overall set, so not even a trusted repository sets its own run limits.
  expect(text).toContain("a repository's run limits are ignored even once you trust it")
  // Only the owner can approve, so an invited guest is told who decides instead of being asked.
  expect(text).toContain("a guest you invite is never asked")
  // An agent or parallel workspace has its own trust, and its question says workspace.
  expect(text).toContain("Trust this workspace?")
  // Not now leaves the user's own language servers and formatters off there too, and the docs say so.
  expect(text).toContain("also stay off in a repository you have not trusted")
  expect(text).not.toContain("Project settings ignored")
  expect(text).not.toContain("Project not trusted")
  // Vector has repositories, not projects (owner rule).
  expect(text).not.toMatch(/project/i)
})
