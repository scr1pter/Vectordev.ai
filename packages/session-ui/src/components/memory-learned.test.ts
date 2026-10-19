import { describe, expect, test } from "bun:test"
import { memoryLearned } from "./memory-learned"

describe("memoryLearned", () => {
  test("reads what the agent put in use, with its words for a repository entry", () => {
    expect(
      memoryLearned({
        action: "add",
        result: "added",
        id: "m4k2q",
        learned: { scope: "repository", text: "Run the engine tests from packages/engine." },
      }),
    ).toEqual({ id: "m4k2q", text: "Run the engine tests from packages/engine." })
  })

  test("a personal entry comes without its words", () => {
    expect(memoryLearned({ action: "add", result: "added", id: "m4k2q", learned: { scope: "personal" } })).toEqual({
      id: "m4k2q",
      text: undefined,
    })
  })

  test("an entry learned from a private document comes without its words, and says so", () => {
    expect(
      memoryLearned({ action: "add", result: "added", id: "m4k2q", learned: { scope: "repository", private: true } }),
    ).toEqual({ id: "m4k2q", text: undefined, private: true })
  })

  test("a document the agent kept comes as one, without the private document's title, for Undo to forget", () => {
    expect(
      memoryLearned({
        action: "add",
        result: "queued",
        id: "d4k2q9x7m",
        learned: { scope: "repository", document: true, private: true },
      }),
    ).toEqual({ id: "d4k2q9x7m", text: undefined, private: true, document: true })
  })

  test("a held write, a search, a refusal and words memory already had are not something learned", () => {
    expect(memoryLearned({ action: "add", result: "held", id: "m4k2q", hold: "web" })).toBeUndefined()
    expect(memoryLearned({ action: "search", result: "2" })).toBeUndefined()
    expect(memoryLearned({ action: "add", result: "refused" })).toBeUndefined()
    expect(memoryLearned({ action: "add", result: "merged", id: "m4k2q" })).toBeUndefined()
    expect(memoryLearned(undefined)).toBeUndefined()
  })
})
