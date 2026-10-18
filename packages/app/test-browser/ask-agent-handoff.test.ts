import { describe, expect, test } from "bun:test"
import path from "node:path"
import { createRoot } from "solid-js"
import { createPromptState } from "@/context/prompt"
import { composerTakes, onComposerPrompt } from "@/utils/composer-handoff"
import { askAgent } from "@/features/pull-requests/ai-review"

// Vectorscope's "Ask the agent" hands its prompt to the task on screen through the generic composer hand-off. A
// composer mounted the way the session page mounts one takes it, unless it holds an unsent draft; only then, or with
// no composer on screen, does a new task start with it.
function mountComposer(prompt: ReturnType<typeof createPromptState>) {
  const sent: string[] = []
  const stop = onComposerPrompt((request) => {
    if (!composerTakes({ dirty: prompt.dirty(), context: prompt.context.items(), open: true })) return false
    prompt.set([{ type: "text", content: request.text, start: 0, end: request.text.length }], request.text.length)
    if (request.send) sent.push(request.text)
    return true
  })
  return { sent, stop }
}

const text = (prompt: ReturnType<typeof createPromptState>) =>
  prompt
    .current()
    .map((part) => ("content" in part ? part.content : ""))
    .join("")

describe("Ask the agent", () => {
  test("a request sent while a session composer is mounted is taken by that composer, not a new task", () =>
    createRoot((dispose) => {
      const prompt = createPromptState()
      const composer = mountComposer(prompt)
      const started: string[] = []
      askAgent("Fix the off-by-one in last().", (prompt) => started.push(prompt))
      composer.stop()
      expect(started).toEqual([])
      expect(composer.sent).toEqual(["Fix the off-by-one in last()."])
      expect(text(prompt)).toBe("Fix the off-by-one in last().")
      dispose()
    }))

  test("a composer holding an unsent draft keeps it, and a new task starts with the request", () =>
    createRoot((dispose) => {
      const prompt = createPromptState()
      prompt.set([{ type: "text", content: "my draft", start: 0, end: 8 }], 8)
      const composer = mountComposer(prompt)
      const started: string[] = []
      askAgent("Fix the off-by-one in last().", (prompt) => started.push(prompt))
      composer.stop()
      expect(started).toEqual(["Fix the off-by-one in last()."])
      expect(composer.sent).toEqual([])
      expect(text(prompt)).toBe("my draft")
      dispose()
    }))

  test("with no composer on screen a new task starts with the request", () => {
    const started: string[] = []
    askAgent("Fix the off-by-one in last().", (prompt) => started.push(prompt))
    expect(started).toEqual(["Fix the off-by-one in last()."])
  })

  // The pages themselves need the whole app around them, so this checks that both still mount a listener from the
  // module Ask the agent sends through: without one, every request would open a new task.
  test("the session page and the new-task page listen for the prompts Ask the agent sends", async () => {
    const source = (file: string) => Bun.file(path.join(import.meta.dir, "../src", file)).text()
    const [review, session, draft] = await Promise.all(
      ["features/pull-requests/ai-review.ts", "pages/session.tsx", "pages/new-session.tsx"].map(source),
    )
    const from = (code: string, name: string) =>
      code.match(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "([^"]+)"`))?.[1]
    const handoff = from(review, "requestComposerPrompt")
    expect(handoff).toBeDefined()
    for (const page of [session, draft]) {
      expect(from(page, "onComposerPrompt")).toBe(handoff)
      expect(page).toMatch(/onCleanup\(\s*onComposerPrompt\(/)
      expect(page).toContain("composerTakes(")
    }
  })
})
