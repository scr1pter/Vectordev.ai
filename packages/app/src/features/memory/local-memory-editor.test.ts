import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createLocalMemoryEditor, type LocalMemoryApi, type LocalMemoryState } from "./local-memory-editor"

const path = "/Users/test/.config/vector/MEMORY.md"

const empty = (): LocalMemoryState => ({ path, exists: false, bytes: 0, entries: 0, content: "" })

const stored = (content: string): LocalMemoryState => ({
  path,
  exists: true,
  bytes: content.length,
  entries: content.split("\n").filter((line) => line.startsWith("- ")).length,
  updatedAt: "2026-08-26T12:00:00.000Z",
  content,
})

function withEditor(api: LocalMemoryApi, run: (editor: ReturnType<typeof createLocalMemoryEditor>) => Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      void run(createLocalMemoryEditor(() => api))
        .then(resolve, reject)
        .finally(dispose)
    })
  })
}

describe("createLocalMemoryEditor", () => {
  test("loads the exact local path and saves trimmed Markdown", () =>
    withEditor(
      {
        read: async () => empty(),
        write: async (content) => stored(content),
        clear: async () => empty(),
      },
      async (editor) => {
        await editor.refresh()
        expect(editor.state()?.path).toBe(path)

        editor.edit()
        editor.setDraft("  - I use Bun for JavaScript projects.  ")
        await editor.save()

        expect(editor.state()?.content).toBe("- I use Bun for JavaScript projects.")
        expect(editor.draft()).toBe("")
        expect(editor.editing()).toBe(false)
      },
    ))

  test("cancel clears unsaved token-like content", () =>
    withEditor(
      {
        read: async () => empty(),
        write: async (content) => stored(content),
        clear: async () => empty(),
      },
      async (editor) => {
        await editor.refresh()
        editor.edit()
        editor.setDraft("sk-test-value-that-must-not-linger")
        editor.cancelEdit()
        editor.edit()

        expect(editor.draft()).toBe("")
        expect(editor.error()).toBe("")
      },
    ))

  test("keeps a failed save editable and surfaces its error", () =>
    withEditor(
      {
        read: async () => empty(),
        write: async () => {
          throw new Error("disk is read-only")
        },
        clear: async () => empty(),
      },
      async (editor) => {
        await editor.refresh()
        editor.edit()
        editor.setDraft("- Prefer concise answers")
        await editor.save()

        expect(editor.editing()).toBe(true)
        expect(editor.draft()).toBe("- Prefer concise answers")
        expect(editor.error()).toContain("disk is read-only")
        expect(editor.busy()).toBe(false)
      },
    ))
})
