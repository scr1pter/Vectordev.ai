import { describe, expect, test } from "bun:test"
import { describeSensitiveBrowserAction } from "../../src/tool/browser"

describe("browser sensitive action detection", () => {
  test("requires approval for external form submission", () => {
    expect(describeSensitiveBrowserAction({ action: "press", key: "Enter" }, undefined)).toContain("submit")
  })

  test("requires approval for destructive and consequential clicks", () => {
    expect(
      describeSensitiveBrowserAction(
        { action: "click", selector: "#deploy" },
        {
          ok: true,
          finalUrl: "https://example.com",
          title: "",
          description: "",
          screenshotDataUrl: "",
          console: [],
          pageErrors: [],
          domSummary: {
            textSample: "",
            inputs: [],
            interactives: [{ tag: "button", text: "Deploy project", selector: "#deploy" }],
          },
        },
      ),
    ).toContain("Deploy project")
  })

  test("does not interrupt harmless navigation clicks", () => {
    expect(
      describeSensitiveBrowserAction(
        { action: "click", selector: "#docs" },
        {
          ok: true,
          finalUrl: "https://example.com",
          title: "",
          description: "",
          screenshotDataUrl: "",
          console: [],
          pageErrors: [],
          domSummary: {
            textSample: "",
            inputs: [],
            interactives: [{ tag: "a", text: "Read documentation", selector: "#docs" }],
          },
        },
      ),
    ).toBeUndefined()
  })
})
