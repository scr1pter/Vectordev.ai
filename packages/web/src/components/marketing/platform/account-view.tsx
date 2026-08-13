/** @jsxImportSource react */
import { useEffect, useState } from "react"
import type { Session } from "@supabase/supabase-js"
import {
  ArrowRight,
  Check,
  Copy,
  CreditCard,
  Download,
  KeyRound,
  Laptop,
  ShieldCheck,
  Sparkles,
} from "lucide-react"
import { apiFetch, formatDate, type PlatformConfig } from "./platform-client"

type AccountStatus = {
  user: { email: string; name?: string; avatarUrl?: string }
  entitlement: {
    access: boolean
    state: string
    plan?: "monthly" | "annual" | "founder"
    expiresAt?: string
    graceEndsAt?: string
    cancelAtPeriodEnd: boolean
    message?: string
  }
  canManageBilling: boolean
  billing: { available: boolean }
}

const installers = [
  ["mac-arm64", "macOS", "Apple silicon"],
  ["mac-x64", "macOS", "Intel"],
  ["windows-x64", "Windows", "64-bit"],
  ["windows-arm64", "Windows", "ARM64"],
  ["linux-x64", "Linux", "x86_64 AppImage"],
  ["linux-arm64", "Linux", "ARM64 AppImage"],
] as const

function accessTitle(status?: AccountStatus) {
  if (status?.entitlement.plan === "founder") return "Founder access"
  if (status?.entitlement.plan === "monthly") return "Vector monthly"
  if (status?.entitlement.plan === "annual") return "Vector annual"
  return "Choose your Vector plan"
}

export function AccountView(props: { session: Session; config?: PlatformConfig; downloadsOnly?: boolean }) {
  const [status, setStatus] = useState<AccountStatus>()
  const [licenseKey, setLicenseKey] = useState("")
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [busy, setBusy] = useState("")
  const [message, setMessage] = useState("")

  const load = async () => {
    try {
      setStatus((await apiFetch("/api/account/status", props.session)) as AccountStatus)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not load your account.")
    }
  }

  useEffect(() => {
    void load()
  }, [props.session.access_token])

  useEffect(() => {
    const checkoutSession = new URLSearchParams(location.search).get("session_id")
    if (!checkoutSession) return
    setBusy("claim")
    apiFetch<{ licenseKey?: string }>(
      "/api/billing/claim?session_id=" + encodeURIComponent(checkoutSession),
      props.session,
    )
      .then((payload) => {
        setLicenseKey(payload.licenseKey || "")
        history.replaceState({}, "", location.pathname)
        return load()
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "Vector could not verify that purchase."))
      .finally(() => setBusy(""))
  }, [props.session.access_token])

  const checkout = async (plan: "monthly" | "annual") => {
    if (!termsAccepted) {
      setMessage("Accept Vector's terms, privacy policy, and software license to continue.")
      return
    }
    setBusy("checkout-" + plan)
    setMessage("")
    try {
      const payload = await apiFetch<{ url: string }>("/api/billing/checkout", props.session, {
        method: "POST",
        body: JSON.stringify({ plan, termsAccepted }),
      })
      location.assign(payload.url)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not open checkout.")
      setBusy("")
    }
  }

  const portal = async () => {
    setBusy("portal")
    setMessage("")
    try {
      const payload = await apiFetch<{ url: string }>("/api/account/portal", props.session, { method: "POST" })
      location.assign(payload.url)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not open billing.")
      setBusy("")
    }
  }

  const download = async (target: string) => {
    setBusy("download-" + target)
    setMessage("")
    try {
      const payload = await apiFetch<{ url: string }>("/api/account/download", props.session, {
        method: "POST",
        body: JSON.stringify({ target }),
      })
      location.assign(payload.url)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not open the installer.")
      setBusy("")
    }
  }

  if (props.downloadsOnly) {
    return (
      <div className="platform-page account-page">
        <header className="platform-page-header">
          <div className="platform-page-title">
            <span>
              <Download size={17} />
            </span>
            <div>
              <h1>Download Vector</h1>
              <p>Install the local agentic workspace on macOS, Windows, or Linux.</p>
            </div>
          </div>
          <span className="platform-status" data-state={status?.entitlement.access ? "active" : "expired"}>
            {status?.entitlement.access ? "download access active" : "plan required"}
          </span>
        </header>
        {!status?.entitlement.access ? (
          <section className="account-download-gate">
            <KeyRound size={22} />
            <h2>A Vector membership unlocks the installers.</h2>
            <p>Your web Builder, desktop workspace, updates, and license are tied to the same account.</p>
            <a className="platform-primary" href="/billing">
              Choose a plan <ArrowRight size={15} />
            </a>
          </section>
        ) : (
          <section className="installer-grid">
            {installers.map(([target, operatingSystem, detail]) => (
              <article key={target}>
                <span>
                  <Laptop size={18} />
                </span>
                <div>
                  <strong>{operatingSystem}</strong>
                  <small>{detail}</small>
                </div>
                <button type="button" onClick={() => void download(target)} disabled={!!busy}>
                  <Download size={15} />
                  {busy === "download-" + target ? "Preparing..." : "Download"}
                </button>
              </article>
            ))}
          </section>
        )}
        {message && <p className="account-message">{message}</p>}
      </div>
    )
  }

  return (
    <div className="platform-page account-page">
      <header className="platform-page-header">
        <div className="platform-page-title">
          <span>
            <CreditCard size={17} />
          </span>
          <div>
            <h1>Membership</h1>
            <p>One subscription for Vector Builder, the desktop app, updates, and protected downloads.</p>
          </div>
        </div>
        <span className="platform-status" data-state={status?.entitlement.state || "expired"}>
          {status?.entitlement.state || "loading"}
        </span>
      </header>

      <section className="account-membership-summary">
        <div>
          <span className="platform-kicker">Current access</span>
          <h2>{accessTitle(status)}</h2>
          <p>
            {status?.entitlement.message ||
              (status?.entitlement.expiresAt
                ? "Renews or expires " + formatDate(status.entitlement.expiresAt)
                : "Build on the web and install Vector locally with the same account.")}
          </p>
        </div>
        {status?.canManageBilling && (
          <button className="platform-secondary" type="button" onClick={() => void portal()} disabled={!!busy}>
            <CreditCard size={15} /> {busy === "portal" ? "Opening..." : "Manage in Stripe"}
          </button>
        )}
      </section>

      {!status?.entitlement.access && (
        <>
          <section className="account-plan-grid" id="membership">
            <article>
              <span>Monthly</span>
              <h3>$10 <small>/ month</small></h3>
              <p>Flexible access to the complete Vector product.</p>
              <ul>
                <li><Check size={14} /> Vector Builder</li>
                <li><Check size={14} /> Desktop app and updates</li>
                <li><Check size={14} /> BYOK models, MCP, and connected tools</li>
              </ul>
              <button
                className="platform-secondary"
                type="button"
                onClick={() => void checkout("monthly")}
                disabled={!!busy || !status?.billing.available}
              >
                {busy === "checkout-monthly" ? "Opening checkout..." : "Choose monthly"}
              </button>
            </article>
            <article data-featured>
              <span>Annual</span>
              <h3>$99 <small>/ year</small></h3>
              <p>Two months less than paying month to month.</p>
              <ul>
                <li><Check size={14} /> Everything in monthly</li>
                <li><Check size={14} /> One annual renewal</li>
                <li><Check size={14} /> Three-day payment grace period</li>
              </ul>
              <button
                className="platform-primary"
                type="button"
                onClick={() => void checkout("annual")}
                disabled={!!busy || !status?.billing.available}
              >
                {busy === "checkout-annual" ? "Opening checkout..." : "Choose annual"}
              </button>
            </article>
          </section>
          <label className="account-terms">
            <input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} />
            <span>
              I agree to Vector's <a href="/legal/terms">terms</a>, <a href="/legal/privacy">privacy policy</a>, and{" "}
              <a href="/legal/license">software license</a>.
            </span>
          </label>
        </>
      )}

      {status?.entitlement.access && (
        <section className="account-access-grid">
          <a href="/account">
            <span><Sparkles size={18} /></span>
            <div>
              <strong>Open Vector Builder</strong>
              <small>Describe, build, run, and refine a real application.</small>
            </div>
            <ArrowRight size={15} />
          </a>
          <a href="/download">
            <span><Download size={18} /></span>
            <div>
              <strong>Download Vector</strong>
              <small>Use the full local workspace on your computer.</small>
            </div>
            <ArrowRight size={15} />
          </a>
        </section>
      )}

      {licenseKey && (
        <section className="account-license-key">
          <ShieldCheck size={18} />
          <div>
            <strong>Your Vector license</strong>
            <code>{licenseKey}</code>
            <small>Store this securely. Vector will not display the full key again.</small>
          </div>
          <button
            type="button"
            title="Copy license"
            onClick={() => {
              void navigator.clipboard.writeText(licenseKey)
              setMessage("License copied.")
            }}
          >
            <Copy size={15} />
          </button>
        </section>
      )}
      {message && <p className="account-message">{message}</p>}
    </div>
  )
}
