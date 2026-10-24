import { describe, expect, test } from "bun:test"
import { isHelperName } from "@vectordevai/core/session/helper"

describe("isHelperName", () => {
  test("accepts the names every helper creation site uses", () => {
    const names = [
      "vectorscope.review",
      "vectorscope.security",
      "vectorscope.verify",
      "codespace.edit",
      "codespace.autocomplete",
      "browser-agent.planner",
      "swarm.planner",
      "brain.learn",
      "research.expand",
      "help.answer",
    ]
    expect(names.filter((name) => !isHelperName(name))).toEqual([])
  })

  test("rejects anything outside Vector's helper names", () => {
    const names = [
      "",
      "true",
      "1",
      "vectorscope",
      "vectorscope.",
      "Vectorscope review",
      "other.planner",
      "swarm.planner ",
      "brain",
      "research.",
      "Brain.learn",
    ]
    expect(names.filter(isHelperName)).toEqual([])
  })
})
