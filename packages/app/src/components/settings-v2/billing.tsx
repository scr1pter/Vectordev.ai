import { Show, createResource, createSignal } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { usePlatform } from "@/context/platform"
import type { VectorLicenseStatus } from "@/license"
import "./settings-v2.css"

const formatDate = (value?: string) => {
  if (!value) return "Not available"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Not available"
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })
}

const label = (status?: VectorLicenseStatus) => {
  if (!status) return "Checking"
  if (status.state === "beta") return "Public beta"
  if (status.state === "development") return "Development build"
  if (status.state === "canceling") return "Cancels at period end"
  if (status.state === "grace") return status.graceEndsAt ? "Payment grace period" : "Offline grace period"
  if (status.state === "past_due") return "Payment required"
  if (status.state === "expired") return "Expired"
  if (status.state === "active") return "Active"
  return "Activation required"
}

const planName = (status?: VectorLicenseStatus) =>
  status?.plan === "monthly" ? "Vector monthly license" : "Vector annual license"
const planPrice = (status?: VectorLicenseStatus) => (status?.plan === "monthly" ? "$10 per month" : "$99 per year")
const renewalName = (status?: VectorLicenseStatus) => (status?.plan === "monthly" ? "monthly" : "annual")

export function SettingsBillingV2() {
  const platform = usePlatform()
  const api = platform.license
  const [busy, setBusy] = createSignal("")
  const [message, setMessage] = createSignal("")
  const [status, actions] = createResource(async () => api?.status())

  const run = async (name: string, action: () => Promise<VectorLicenseStatus>, success: string) => {
    if (busy()) return false
    setBusy(name)
    setMessage("")
    try {
      const next = await action()
      actions.mutate(next)
      setMessage(success)
      return true
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Vector could not update billing.")
      return false
    } finally {
      setBusy("")
    }
  }

  const openPortal = async () => {
    if (!api || busy()) return
    setBusy("portal")
    setMessage("")
    try {
      await api.openBillingPortal()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Vector could not open the billing portal.")
    } finally {
      setBusy("")
    }
  }

  return (
    <section class="settings-v2-page settings-license-page">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">License</p>
          <h2 class="settings-v2-page-title">Billing &amp; access</h2>
          <p class="settings-v2-page-subtitle">Manage the Vector plan active on this computer.</p>
        </div>
      </div>

      <div class="settings-license-content">
        <Show
          when={api}
          fallback={
            <div class="settings-license-card">
              <h3>Desktop billing only</h3>
              <p>License controls are available in the Vector desktop application.</p>
            </div>
          }
        >
          <div class="settings-license-card settings-license-card--summary">
            <div class="settings-license-status-line">
              <div>
                <span class="settings-license-eyebrow">{planName(status())}</span>
                <h3>{label(status())}</h3>
              </div>
              <span class="settings-license-badge" data-state={status()?.state}>
                {label(status())}
              </span>
            </div>
            <p>
              {status()?.message ??
                `One active computer, desktop updates, and Vector access for ${planPrice(status())}.`}
            </p>
            <div class="settings-license-facts">
              <div>
                <span>Account</span>
                <strong>{status()?.email || "Not connected"}</strong>
              </div>
              <div>
                <span>{status()?.graceEndsAt ? "Payment grace ends" : "Access through"}</span>
                <strong>{formatDate(status()?.graceEndsAt ?? status()?.expiresAt)}</strong>
              </div>
              <div>
                <span>Plan</span>
                <strong>{planPrice(status())}</strong>
              </div>
              <div>
                <span>Active computer</span>
                <strong>{status()?.deviceName || "This computer"}</strong>
              </div>
              <div>
                <span>License</span>
                <strong>{status()?.lastFour ? `Ends in ${status()?.lastFour}` : "Managed by Vector"}</strong>
              </div>
            </div>
          </div>

          <Show when={status()?.state !== "beta" && status()?.state !== "development"}>
            <div class="settings-license-card">
              <div class="settings-license-card-copy">
                <h3>Subscription</h3>
                <p>Stripe securely manages payment methods, invoices, and renewal details.</p>
              </div>
              <div class="settings-license-buttons">
                <ButtonV2 variant="outline" icon="link" disabled={!!busy()} onClick={openPortal}>
                  {busy() === "portal" ? "Opening..." : "Manage billing"}
                </ButtonV2>
                <ButtonV2
                  variant={status()?.cancelAtPeriodEnd ? "outline" : "danger"}
                  icon={status()?.cancelAtPeriodEnd ? "reset" : "circle-ban-sign"}
                  disabled={!!busy() || !status()?.access}
                  onClick={() => {
                    if (!api) return
                    const cancel = !status()?.cancelAtPeriodEnd
                    if (
                      cancel &&
                      !globalThis.confirm("Cancel renewal? Vector will keep working until the end of the paid period.")
                    )
                      return
                    void run(
                      "renewal",
                      () => api.setCancellation(cancel),
                      cancel
                        ? "Renewal cancelled. Vector remains active through the paid period."
                        : `${renewalName(status()) === "monthly" ? "Monthly" : "Annual"} renewal restored.`,
                    )
                  }}
                >
                  {busy() === "renewal"
                    ? "Updating..."
                    : status()?.cancelAtPeriodEnd
                      ? `Resume ${renewalName(status())} renewal`
                      : `Cancel ${renewalName(status())} renewal`}
                </ButtonV2>
              </div>
            </div>

            <div class="settings-license-card">
              <div class="settings-license-card-copy">
                <h3>Computer activation</h3>
                <p>Deactivate this computer before moving the license to another one.</p>
              </div>
              <ButtonV2
                variant="outline"
                icon="trash"
                disabled={!!busy()}
                onClick={() => {
                  if (
                    !api ||
                    !globalThis.confirm(
                      "Deactivate Vector on this computer? You will need your license key to activate again.",
                    )
                  )
                    return
                  void run("device", () => api.deactivate(), "This computer was deactivated.").then((success) => {
                    if (success) globalThis.location.reload()
                  })
                }}
              >
                {busy() === "device" ? "Deactivating..." : "Deactivate this computer"}
              </ButtonV2>
            </div>
          </Show>

          <Show when={status()?.state === "beta" || status()?.state === "development"}>
            <div class="settings-license-card">
              <div class="settings-license-card-copy">
                <h3>Paid launch not active</h3>
                <p>This build remains fully usable while Vector's production billing service is being configured.</p>
              </div>
              <ButtonV2
                variant="outline"
                icon="link"
                onClick={() => platform.openLink("https://vectordev.ai/download")}
              >
                View Vector plans
              </ButtonV2>
            </div>
          </Show>

          <Show when={message()}>
            <p class="settings-license-message" role="status">
              {message()}
            </p>
          </Show>
        </Show>
      </div>
    </section>
  )
}
