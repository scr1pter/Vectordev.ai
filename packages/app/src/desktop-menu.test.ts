import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU } from "./desktop-menu"

describe("desktop menu", () => {
  test("exports logs through the desktop command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.label === "Export Logs...",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })

  test("Help reports and feedback use the public Vector support form", () => {
    const help = DESKTOP_MENU.find((menu) => menu.id === "help")
    const reports = help?.items
      ?.filter((item) => item.type === "item")
      .filter((item) => item.label === "Report a Bug" || item.label === "Share Feedback")
    expect(reports).toHaveLength(2)
    expect(reports?.every((item) => item.href === "https://vectordev.ai/support/report")).toBe(true)
  })
})
