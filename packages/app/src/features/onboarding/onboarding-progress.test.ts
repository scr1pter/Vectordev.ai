import { describe, expect, test } from "bun:test"
import { successfulActivationFromSession } from "./onboarding-progress"

const user = {
  info: { role: "user" },
  parts: [{ type: "text", text: "Inspect this repository and summarize its architecture." }],
}
const assistant = {
  info: {
    role: "assistant",
    providerID: "anthropic",
    modelID: "claude-sonnet",
    finish: "stop",
    time: { completed: 42 },
    tokens: { output: 18 },
  },
  parts: [{ type: "text", text: "This repository is organized into four primary packages." }],
}

describe("successfulActivationFromSession", () => {
  test("requires a real user prompt and a completed provider response", () => {
    expect(successfulActivationFromSession([user, assistant])).toBe(true)
    expect(successfulActivationFromSession([assistant])).toBe(false)
  })

  test("does not claim activation for errored or unfinished responses", () => {
    expect(
      successfulActivationFromSession([
        user,
        { ...assistant, info: { ...assistant.info, error: { name: "ProviderAuthError" } } },
      ]),
    ).toBe(false)
    expect(
      successfulActivationFromSession([
        user,
        { ...assistant, info: { ...assistant.info, time: {}, tokens: { output: 0 } } },
      ]),
    ).toBe(false)
  })

  test("accepts a terminal text response when usage metadata is unavailable", () => {
    expect(
      successfulActivationFromSession([
        user,
        {
          info: { ...assistant.info, tokens: { output: 0 } },
          parts: [{ type: "text", text: "Repository summary" }],
        },
      ]),
    ).toBe(true)
  })

  test("rejects an earlier tool-call response followed by a terminal error", () => {
    expect(
      successfulActivationFromSession([
        user,
        {
          ...assistant,
          info: { ...assistant.info, finish: "tool-calls" },
          parts: [{ type: "text", text: "I'll inspect the repository now." }],
        },
        {
          ...assistant,
          info: { ...assistant.info, finish: "error", error: { name: "UnknownError" } },
          parts: [],
        },
      ]),
    ).toBe(false)
  })

  test("requires the latest user turn to reach a successful final response", () => {
    expect(
      successfulActivationFromSession([
        user,
        assistant,
        { ...user, parts: [{ type: "text", text: "Now inspect the test suite." }] },
        {
          ...assistant,
          info: { ...assistant.info, finish: "error", error: { name: "APIError" } },
          parts: [],
        },
      ]),
    ).toBe(false)
  })

  test("accepts a tool call only after a final assistant response completes", () => {
    expect(
      successfulActivationFromSession([
        user,
        {
          ...assistant,
          info: { ...assistant.info, finish: "tool-calls" },
          parts: [{ type: "text", text: "I'll inspect the repository now." }],
        },
        assistant,
      ]),
    ).toBe(true)
  })

  test("ignores synthetic prompts and assistant summaries", () => {
    expect(
      successfulActivationFromSession([
        { ...user, parts: [{ type: "text", text: "Continue", synthetic: true }] },
        assistant,
      ]),
    ).toBe(false)
    expect(
      successfulActivationFromSession([
        user,
        { ...assistant, info: { ...assistant.info, summary: true } },
      ]),
    ).toBe(false)
  })
})
