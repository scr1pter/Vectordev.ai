/** The report remains an editable local draft until the user submits the form. */
export function initializeSupportReport(form: HTMLFormElement, request: typeof fetch = fetch) {
  const message = form.querySelector<HTMLTextAreaElement>("[name=message]")!
  const email = form.querySelector<HTMLInputElement>("[name=email]")!
  const status = form.querySelector<HTMLElement>("#report-status")!
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!
  const parent = window.opener
  const draft = (event: MessageEvent) => {
    if (!parent || event.source !== parent || event.data?.type !== "vector:support-draft") return
    if (typeof event.data.message !== "string" || event.data.message.length > 8_000 || message.value) return
    message.value = event.data.message
    window.removeEventListener("message", draft)
    // The opener can only supply draft text, never submit or choose a destination.
    window.opener = null
  }
  window.addEventListener("message", draft)
  parent?.postMessage({ type: "vector:support-ready" }, "*")
  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    if (submit.disabled || !message.value.trim() || message.value.length > 8_000 || !form.reportValidity()) return
    submit.disabled = true
    status.textContent = "Sending…"
    const response = await request("/api/support/bug-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message.value.trim(), email: email.value.trim() || undefined }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    }).catch(() => undefined)
    if (!response) {
      status.textContent = "Vector could not reach the report service. Your draft is still here; try again."
      submit.disabled = false
      return
    }
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => undefined)
      status.textContent =
        error &&
        typeof error === "object" &&
        "error" in error &&
        error.error &&
        typeof error.error === "object" &&
        "message" in error.error &&
        typeof error.error.message === "string"
          ? error.error.message.slice(0, 500)
          : "The report could not be delivered. Your draft is still here; try again."
      submit.disabled = false
      return
    }
    const result: unknown = await response.json().catch(() => undefined)
    if (!result || typeof result !== "object" || !("delivered" in result) || result.delivered !== true) {
      status.textContent = "Vector could not confirm report delivery. Your draft is still here."
      submit.disabled = false
      return
    }
    message.value = ""
    email.value = ""
    status.textContent = "Report sent. If you left an email, the Vector team can reply there."
    submit.textContent = "Report sent"
  })
  return () => window.removeEventListener("message", draft)
}
