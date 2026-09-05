import { type ParentProps, Show, createEffect, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { usePlatform } from "@/context/platform"
import type { VectorLicenseStatus } from "@/license"
import "./license-gate.css"

const fallbackStatus: VectorLicenseStatus = {
  access: true,
  state: "development",
  message: "Licensing is unavailable on this platform.",
}

// Re-check this often while the app runs unverified, so the real answer (beta,
// or activation required) lands as soon as the network comes back instead of
// at the next quarter-hour poll.
const OFFLINE_RETRY_MS = 60 * 1_000

const unreachableStatus = (cause: unknown): VectorLicenseStatus => ({
  access: false,
  state: "offline",
  message: `Vector could not check licensing: ${cause instanceof Error ? cause.message : String(cause)}`,
})

// The license service only carries lastValidatedAt/email on a status derived
// from a stored activation. An offline status without them means this computer
// was never activated, and a captive portal or blocked network must not wall
// off a brand-new user. A device that once held a token keeps the wall until
// the service can say whether that token is still good.
export function offlineWithoutActivation(status: VectorLicenseStatus | undefined) {
  return Boolean(
    status &&
      status.state === "offline" &&
      !status.access &&
      !status.enforced &&
      !status.lastValidatedAt &&
      !status.email,
  )
}

export function LicenseGate(props: ParentProps) {
  const platform = usePlatform()
  const license = platform.license
  const [key, setKey] = createSignal("")
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  // A bridge failure must not strand a new user on the loading screen, so a
  // thrown status is treated like an unreachable licensing service.
  const [status, actions] = createResource(async () =>
    license ? license.status().catch((cause: unknown) => unreachableStatus(cause)) : fallbackStatus,
  )
  const passThrough = () => offlineWithoutActivation(status())
  const allowed = () => Boolean(status()?.access) || passThrough()
  // "refreshing" still has the previous value: a background refetch must not
  // unmount the app behind the gate.
  const settled = () => status.state === "ready" || status.state === "refreshing"

  onMount(() => {
    const timer = window.setInterval(() => void actions.refetch(), 15 * 60 * 1_000)
    onCleanup(() => window.clearInterval(timer))
  })

  createEffect(() => {
    if (!passThrough()) return
    const timer = window.setTimeout(() => void actions.refetch(), OFFLINE_RETRY_MS)
    onCleanup(() => window.clearTimeout(timer))
  })

  createEffect(() => {
    const current = status()
    if (current?.state !== "grace" || !current.graceEndsAt) return
    const remaining = Date.parse(current.graceEndsAt) - Date.now()
    const timer = window.setTimeout(
      () => void actions.refetch(),
      Math.max(1_000, Math.min(remaining + 1_000, 2_147_000_000)),
    )
    onCleanup(() => window.clearTimeout(timer))
  })

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
    if (status()?.plan === "monthly" && status()?.state === "expired") {
      platform.openLink("https://vectordev.ai/download?reactivate=1")
      return
    }
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
      when={settled()}
      fallback={
        <div class="vector-license-loading">
          <img src="/vector-logo.png" alt="" />
          <span>Checking Vector license...</span>
        </div>
      }
    >
      <Show
        when={allowed()}
        fallback={
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
                  {busy()
                    ? "Opening..."
                    : status()?.plan === "monthly" && status()?.state === "expired"
                      ? "Choose a plan"
                      : "Fix payment"}
                </button>
              </Show>

              <Show when={error()}>
                <p class="vector-license-error" role="alert">
                  {error()}
                </p>
              </Show>

              <div class="vector-license-actions">
                <button type="button" onClick={() => platform.openLink("https://vectordev.ai/download")}>
                  View monthly and annual plans
                </button>
                <button type="button" onClick={() => void actions.refetch()}>
                  Try again
                </button>
              </div>
              <p class="vector-license-footnote">
                One active computer per license. Billing is securely handled by Stripe.
              </p>
            </section>
          </main>
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}
