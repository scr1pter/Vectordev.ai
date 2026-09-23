import { describe, expect, test } from "bun:test"
import { NO_TEAMMATES_DETAIL } from "../../src/tool/teammate"

describe("teammate guidance", () => {
  test("a missing team marker stops agents from probing Vector application data", () => {
    expect(NO_TEAMMATES_DETAIL).toContain("separate child sessions")
    expect(NO_TEAMMATES_DETAIL).toContain("Stop this coordination attempt")
    expect(NO_TEAMMATES_DETAIL).toContain("Do not search outside the workspace")
    expect(NO_TEAMMATES_DETAIL).toContain("report the unavailable teammate exchange to the parent")
  })
})
