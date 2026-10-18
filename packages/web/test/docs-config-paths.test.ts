import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { faqs, runGuardRows } from "../src/data/docs-content"

const docs = new URL("../src/pages/docs/", import.meta.url)

// Paragraphs, list items and cells as readers see them, without markup.
async function passages() {
  const pages = (await readdir(docs)).filter((file) => file.endsWith(".astro"))
  const html = await Promise.all(pages.map((file) => Bun.file(new URL(file, docs)).text()))
  return [
    ...html.flatMap((text) => text.split(/<\/(?:p|li|article|td|dd)>/)),
    ...runGuardRows.map((row) => row.join(" ")),
    ...faqs.map((faq) => `${faq.question} ${faq.answer}`),
  ].map((text) => text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "))
}

// The desktop app runs its engine with its config folder inside its app data, so it never reads ~/.config/vector.
// A passage that sends someone there has to say it is the terminal's, or a desktop user edits a file nothing reads.
test("the docs name ~/.config/vector only as the terminal's config", async () => {
  const named = (await passages()).filter((text) => text.includes("~/.config/vector/"))
  expect(named.length).toBeGreaterThan(0)
  expect(named.filter((text) => !/terminal/i.test(text))).toEqual([])
})

test("rules for every repository point desktop users at the desktop app's own AGENTS.md", async () => {
  const rules = (await passages()).find((text) => text.includes("Rules for every repository"))
  expect(rules).toContain("~/Library/Application Support/ai.vector.app/config/vector/AGENTS.md on macOS")
  expect(rules).toContain("%APPDATA%\\ai.vector.app\\config\\vector\\AGENTS.md on Windows")
  expect(rules).toContain("~/.config/ai.vector.app/config/vector/AGENTS.md on Linux")
  expect(rules).toContain("The terminal reads ~/.config/vector/AGENTS.md")
})
