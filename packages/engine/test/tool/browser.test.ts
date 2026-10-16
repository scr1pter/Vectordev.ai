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

  test("requires approval for the cloud dashboard actions vector_cloud asks for every time", () => {
    for (const text of [
      "Promote to Production",
      "Instant Rollback",
      "Roll Back",
      "Redeploy",
      "Save",
      "Add Environment Variable",
      "Run",
      "Pause project",
      "Restore project",
      "Reset database password",
      "Rotate key",
      "Revoke access",
      "Invite user",
      "Uninstall",
      "Disconnect",
    ]) {
      const report = {
        ok: true,
        finalUrl: "https://vercel.com/team/shop",
        title: "",
        description: "",
        screenshotDataUrl: "",
        console: [],
        pageErrors: [],
        domSummary: { textSample: "", inputs: [], interactives: [{ tag: "button", text, selector: "#action" }] },
      }
      expect({ text, asked: describeSensitiveBrowserAction({ action: "click", selector: "#action" }, report) }).toEqual(
        {
          text,
          asked: `Click ${text} on an external page`,
        },
      )
    }
  })

  test("requires approval for every key that presses a button or submits a form", () => {
    for (const key of ["Return", "NumpadEnter", "Space", " ", "Control+Enter", "Meta+Return", "Shift+Space"]) {
      expect({
        key,
        asked: describeSensitiveBrowserAction({ action: "press", key }, page("https://example.com")),
      }).toEqual({ key, asked: expect.stringContaining("press the focused button") })
    }
    expect(describeSensitiveBrowserAction({ action: "press", key: "Tab" }, page("https://example.com"))).toBeUndefined()
    expect(
      describeSensitiveBrowserAction(
        { action: "type", selector: "#q", text: "drop table x\n" },
        page("https://example.com"),
      ),
    ).toContain("line break")
    expect(
      describeSensitiveBrowserAction({ action: "type", selector: "#q", text: "shoes" }, page("https://example.com")),
    ).toBeUndefined()
  })

  test("judges a positional selector by the name of the element it matches", () => {
    for (const [selector, label] of [
      ["div[role=dialog] button:last-child", "Promote"],
      ["button.bg-primary", "Instant Rollback"],
    ]) {
      const report = { ...page("https://example.com"), target: { found: true, label } }
      expect(describeSensitiveBrowserAction({ action: "click", selector }, report)).toBe(
        `Click ${label} on an external page`,
      )
    }
    const missing = { ...page("https://example.com"), target: { found: false, label: "" } }
    expect(describeSensitiveBrowserAction({ action: "click", selector: "button.bg-primary" }, missing)).toBeUndefined()
  })

  test("requires approval for every click and key press on the Vercel and Supabase dashboards", () => {
    for (const url of [
      "https://vercel.com/team-a/shop/deployments",
      "https://supabase.com/dashboard/project/abc/settings/api",
    ]) {
      const report = { ...page(url), target: { found: true, label: "Overview" } }
      expect({ url, asked: describeSensitiveBrowserAction({ action: "click", selector: "#tab" }, report) }).toEqual({
        url,
        asked: expect.stringContaining("dashboard"),
      })
      expect({ url, asked: describeSensitiveBrowserAction({ action: "press", key: "Tab" }, report) }).toEqual({
        url,
        asked: expect.stringContaining("dashboard"),
      })
    }
    for (const url of ["https://vercel.com/docs/deployments", "https://supabase.com/docs/guides/database"]) {
      const report = { ...page(url), target: { found: true, label: "Overview" } }
      expect({ url, asked: describeSensitiveBrowserAction({ action: "click", selector: "#tab" }, report) }).toEqual({
        url,
        asked: undefined,
      })
    }
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

function page(finalUrl: string) {
  return {
    ok: true,
    finalUrl,
    title: "",
    description: "",
    screenshotDataUrl: "",
    console: [],
    pageErrors: [],
    domSummary: { textSample: "", inputs: [], interactives: [] },
  }
}
