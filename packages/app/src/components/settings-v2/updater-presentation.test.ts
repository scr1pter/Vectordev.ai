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

  test("says the installed version is the latest when the feed has nothing newer", () => {
    expect(updaterPresentation({ status: "up-to-date" }, "1.99.99")).toEqual({
      title: "Vector is up to date",
      description: "Vector 1.99.99 is the latest release.",
      action: "Check again",
    })
  })
})
