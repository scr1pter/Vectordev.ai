import { type ParentProps, Show, createResource, createSignal } from "solid-js"
import { usePlatform } from "@/context/platform"
import type { VectorLicenseStatus } from "@/license"
import "./license-gate.css"

const fallbackStatus: VectorLicenseStatus = {
  access: true,
  state: "development",
  message: "Licensing is unavailable on this platform.",
}

export function LicenseGate(props: ParentProps) {
  const platform = usePlatform()
  const license = platform.license
  const [key, setKey] = createSignal("")
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [status, actions] = createResource(async () => (license ? license.status() : fallbackStatus))

  const activate = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!license || !key().trim() || busy()) return
    setBusy(true)
    setError("")
    try {
      await license.activate(key().trim())
      setKey("")
      await actions.refetch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not activate this license.")
    } finally {
      setBusy(false)
    }
  }

  const openBilling = async () => {
    if (!license || busy()) return
    setBusy(true)
    setError("")
    try {
      await license.openBillingPortal()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not open billing.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show
      when={status.state === "ready"}
      fallback={
        <div class="vector-license-loading">
          <img src="/vector-logo.png" alt="" />
          <span>Checking Vector license...</span>
        </div>
      }
    >
      <Show when={status()?.access} fallback={
        <main class="vector-license-gate">
          <div class="vector-license-glow" aria-hidden="true" />
          <section class="vector-license-panel" aria-labelledby="vector-license-title">
            <img class="vector-license-mark" src="/vector-logo.png" alt="" />
            <p class="vector-license-kicker">Vector desktop</p>
            <h1 id="vector-license-title">
              {status()?.state === "expired"
                ? "Your Vector license has expired"
                : status()?.state === "past_due"
                  ? "Payment needs attention"
                  : status()?.state === "offline"
                    ? "License verification is offline"
                    : "Activate Vector"}
            </h1>
            <p class="vector-license-message">
              {status()?.message ?? "Enter the license key from your Vector purchase email."}
            </p>

            <Show when={status()?.state === "activation_required" || status()?.state === "offline"}>
              <form class="vector-license-form" onSubmit={activate}>
                <label for="vector-license-key">License key</label>
                <input
                  id="vector-license-key"
                  type="text"
                  value={key()}
                  onInput={(event) => setKey(event.currentTarget.value)}
                  placeholder="VEC1..."
                  autocomplete="off"
                  spellcheck={false}
                  disabled={busy()}
                />
                <button class="vector-license-primary" type="submit" disabled={busy() || !key().trim()}>
                  {busy() ? "Activating..." : "Activate this computer"}
                </button>
              </form>
            </Show>

            <Show when={status()?.state === "expired" || status()?.state === "past_due"}>
              <button class="vector-license-primary" type="button" disabled={busy()} onClick={openBilling}>
                {busy() ? "Opening..." : "Reactivate subscription"}
              </button>
            </Show>

            <Show when={error()}>
              <p class="vector-license-error" role="alert">{error()}</p>
            </Show>

            <div class="vector-license-actions">
              <button type="button" onClick={() => platform.openLink("https://vectordev.ai/download")}>Buy Vector - $99/year</button>
              <button type="button" onClick={() => void actions.refetch()}>Try again</button>
            </div>
            <p class="vector-license-footnote">One active computer per license. Billing is securely handled by Stripe.</p>
          </section>
        </main>
      }>
        {props.children}
      </Show>
    </Show>
  )
}
