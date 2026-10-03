import { describe, expect, test } from "bun:test"
import { updaterPresentation } from "./updater-presentation"

describe("updater presentation", () => {
  test("explains why development builds cannot update", () => {
    expect(updaterPresentation({ status: "disabled" }, "1.19.100")).toEqual({
      title: "Updates unavailable in this build",
      description:
        "Vector 1.19.100 is not connected to a release feed. Install a packaged production build to check for updates here.",
    })
  })

  test("offers restart when an update is ready", () => {
    expect(updaterPresentation({ status: "ready", version: "1.19.101" }, "1.19.100").action).toBe("Restart to update")
  })

  test("reports download progress", () => {
    expect(updaterPresentation({ status: "downloading", version: "1.19.101", percent: 48.7 }).description).toContain(
      "49% complete",
    )
  })

  test("does not confuse the automatic update feed with manual-download releases", () => {
    expect(updaterPresentation({ status: "up-to-date" }, "1.99.1")).toEqual({
      title: "Automatic updates are current",
      description:
        "No newer automatic update is available for Vector 1.99.1. Check Latest installers for manual-download releases.",
      action: "Check again",
    })
  })
})
