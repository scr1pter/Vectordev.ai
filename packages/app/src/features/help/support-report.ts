export const supportReportUrl = "https://vectordev.ai/support/report"

/** Transfer the draft only to the Vector form window, never through a URL or browser storage. */
export function openSupportReport(message: string, browser: Window = window) {
  const popup = browser.open(supportReportUrl, "_blank")
  if (!popup) throw new Error("Allow the Vector support window to open, then try again.")
  const ready = (event: MessageEvent) => {
    if (
      event.source !== popup ||
      event.origin !== "https://vectordev.ai" ||
      event.data?.type !== "vector:support-ready"
    )
      return
    popup.postMessage({ type: "vector:support-draft", message: message.slice(0, 8_000) }, "https://vectordev.ai")
    cleanup()
  }
  const cleanup = () => {
    clearTimeout(timeout)
    browser.removeEventListener("message", ready)
  }
  browser.addEventListener("message", ready)
  const timeout = setTimeout(cleanup, 30_000)
  return cleanup
}
