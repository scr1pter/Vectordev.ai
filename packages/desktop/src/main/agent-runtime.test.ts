import { describe, expect, test } from "bun:test"
import { VECTOR_AGENT_RUNTIME_ENV } from "./agent-runtime"

describe("Vector agent runtime", () => {
  test("enables real background subagents in desktop runtimes", () => {
    expect(VECTOR_AGENT_RUNTIME_ENV.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBe("true")
  })
})
