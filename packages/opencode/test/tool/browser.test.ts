import { describe, expect, test } from "bun:test"
import { describeSensitiveBrowserAction, isLocalUrl } from "../../src/tool/browser"

describe("browser sensitive action detection", () => {
  test("requires permission for LAN hosts as well as internet hosts", () => {
    expect(isLocalUrl("http://localhost:3000")).toBe(true)
    expect(isLocalUrl("http://127.0.0.1:4173")).toBe(true)
    expect(isLocalUrl("http://10.0.0.2")).toBe(false)
    expect(isLocalUrl("http://172.16.0.2")).toBe(false)
    expect(isLocalUrl("http://192.168.1.2")).toBe(false)
  })

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
