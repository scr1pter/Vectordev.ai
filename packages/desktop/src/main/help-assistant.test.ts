import { afterEach, expect, test } from "bun:test"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { askHelpAssistant } from "./help-assistant"

afterEach(() => {
  Egress.configure(LocalPolicy.OFF)
})

test("answers that the help assistant is off with Vector Local on, before anything is sent", async () => {
  Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))
  const result = await askHelpAssistant({ messages: [{ role: "user", content: "How do I add a model?" }], context: "" })
  expect(result.error).toBe(
    "The help assistant is off while Vector Local is on, because it sends your question to vectordev.ai. The Vector docs answer most questions without it.",
  )
  expect(Egress.events({ blocked: true }).map((event) => `${event.source} ${event.origin}`)).toEqual([
    "help-assistant https://vectordev.ai",
  ])
})
