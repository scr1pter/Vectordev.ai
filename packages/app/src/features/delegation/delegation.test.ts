import { describe, expect, test } from "bun:test"
import { detectParallelIntent } from "./delegation"

describe("detectParallelIntent", () => {
  test("splits on an explicit phrase with sentence-level separators", () => {
    const value = detectParallelIntent(
      "Delegate this work: refactor the login page; write new tests for it",
    )
    expect(value).toEqual({
      explicit: true,
      missions: ["Delegate this work: refactor the login page", "write new tests for it"],
    })
  })

  test("falls back to the whole prompt as a single mission for an explicit phrase with no list or separators", () => {
    const value = detectParallelIntent("Please split this task up across a few agents for me")
    expect(value).toEqual({
      explicit: true,
      missions: ["Please split this task up across a few agents for me"],
    })
  })

  test("detects an implicit numbered list of independent tasks", () => {
    const value = detectParallelIntent(
      "1. Fix the header alignment bug in Navbar.tsx\n2. Update CHANGELOG.md for v2 release",
    )
    expect(value).toEqual({
      explicit: false,
      missions: ["Fix the header alignment bug in Navbar.tsx", "Update CHANGELOG.md for v2 release"],
    })
  })

  test("detects an implicit bulleted list of independent tasks", () => {
    const value = detectParallelIntent(
      "- Refactor the payment service completely\n- Add integration tests for the checkout flow",
    )
    expect(value).toEqual({
      explicit: false,
      missions: ["Refactor the payment service completely", "Add integration tests for the checkout flow"],
    })
  })

  test("never triggers on a question, even with explicit phrasing", () => {
    const value = detectParallelIntent(
      "Should we fix the login bug and update the docs at the same time?",
    )
    expect(value).toBeUndefined()
  })

  test("never triggers on prompts under 20 characters", () => {
    expect(detectParallelIntent("fix bug")).toBeUndefined()
    expect(detectParallelIntent("1. a\n2. b")).toBeUndefined()
  })

  test("never triggers on a single-item list with no explicit phrase", () => {
    const value = detectParallelIntent("1. Refactor the entire authentication module for security")
    expect(value).toBeUndefined()
  })

  test("never triggers on a list whose items are too short", () => {
    const value = detectParallelIntent("1. Fix bug\n2. Add test")
    expect(value).toBeUndefined()
  })

  test("treats a single-item list with an explicit phrase as one mission, not a split", () => {
    const value = detectParallelIntent("Delegate this:\n1. Refactor the entire authentication module")
    expect(value).toEqual({
      explicit: true,
      missions: ["Delegate this:\n1. Refactor the entire authentication module"],
    })
  })

  test("preserves exact mission text, trimmed but otherwise untouched", () => {
    const value = detectParallelIntent(
      "1.   Fix the header alignment issue in the Navbar   \n2.  Update the CHANGELOG for this release  ",
    )
    expect(value?.missions).toEqual([
      "Fix the header alignment issue in the Navbar",
      "Update the CHANGELOG for this release",
    ])
  })
})
