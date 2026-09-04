/** @jsxImportSource react */
import { Check, Copy, LoaderCircle } from "lucide-react"
import { useEffect, useState } from "react"
import { readAccountApiResponse, takeAccountReturnPath, vectorAccountClient } from "../../../lib/account-client"
import { FreeDownload } from "../purchase/FreeDownload"
import { CliLaunchPanel } from "./CliLaunchPanel"
import "../purchase/purchase.css"
import "./account.css"

type LicenseStatus = {
  access: boolean
  state: "active" | "canceling" | "grace" | "expired" | "past_due" | "revoked"
  plan: "annual" | "monthly"
  interval: "year" | "month"
}

type AccountState = {
  user: { id: string; email: string; name?: string }
  billing?: { status: LicenseStatus; licenseKey?: string }
  purchasesAvailable: boolean
  betaAccess: boolean
}

type BillingConfig = {
  releaseVersion?: string
  plans?: Array<{ id: "monthly" | "annual"; priceUsd: number; interval: "month" | "year" }>
}

const fallbackPlans: NonNullable<BillingConfig["plans"]> = [
  { id: "annual", priceUsd: 99, interval: "year" },
  { id: "monthly", priceUsd: 10, interval: "month" },
]

/**
 * /account — the signed-in page. One column, flat sections, no marketing.
 * Download, CLI, plan & billing, account.
 */
export function AccountPage(props: { preview?: AccountState }) {
  const [token, setToken] = useState("")
  const [account, setAccount] = useState<AccountState | undefined>(props.preview)
  const [configuration, setConfiguration] = useState<BillingConfig>({ plans: fallbackPlans })
  const [plan, setPlan] = useState<"annual" | "monthly">("annual")
  const [terms, setTerms] = useState(false)
  const [loading, setLoading] = useState(!props.preview)
  const [action, setAction] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [copied, setCopied] = useState(false)
  const downloadAllowed = Boolean(account?.betaAccess || account?.billing?.status.access)

  const loadAccount = (accessToken: string) =>
    fetch("/api/account/status", {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    }).then(async (response) => {
      const payload = await readAccountApiResponse(response, "Vector could not load your account.")
      if (!isAccountState(payload)) throw new Error("Vector could not load your account.")
      setAccount(payload)
    })

  useEffect(() => {
    // Design-preview mode (dev-only route) renders fixtures without auth.
    if (props.preview) return
    let unsubscribe: (() => void) | undefined
    void vectorAccountClient()
      .then(async (client) => {
        const listener = client.auth.onAuthStateChange((event, session) => {
          if (session) setToken(session.access_token)
          if (event === "SIGNED_OUT") location.replace("/login")
        })
        unsubscribe = () => listener.data.subscription.unsubscribe()
        const parameters = new URLSearchParams(location.search)
        const code = parameters.get("code")
        if (code) {
          const exchange = await client.auth.exchangeCodeForSession(code)
          if (exchange.error) throw exchange.error
          const returnTo = takeAccountReturnPath()
          history.replaceState({}, "", "/account")
          if (returnTo !== "/account") {
            location.replace(returnTo)
            return
          }
        }
        const session = await client.auth.getSession()
        if (session.error) throw session.error
        if (!session.data.session) {
          location.replace(`/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`)
          return
        }
        const accessToken = session.data.session.access_token
        setToken(accessToken)
        await Promise.all([
          loadAccount(accessToken),
          fetch("/api/billing/config", { headers: { accept: "application/json" } })
            .then(async (response) => {
              const payload = await readAccountApiResponse(response, "Vector billing is unavailable.")
              const plans = Array.isArray(payload.plans) ? payload.plans.filter(isBillingPlan) : fallbackPlans
              setConfiguration({
                plans: plans.length ? plans : fallbackPlans,
                ...(typeof payload.releaseVersion === "string" ? { releaseVersion: payload.releaseVersion } : {}),
              })
            })
            .catch(() => undefined),
        ])

        const checkoutSession = parameters.get("session_id")
        if (parameters.get("checkout") === "success" && checkoutSession) {
          setNotice("Finishing your Vector license…")
          const claim = await fetch("/api/billing/claim", {
            method: "POST",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ sessionId: checkoutSession }),
          })
          await readAccountApiResponse(claim, "Vector could not finish your purchase.")
          await loadAccount(accessToken)
          setNotice("Your Vector license is ready.")
          history.replaceState({}, "", "/account")
        }
        if (parameters.get("checkout") === "cancelled") {
          setNotice("Checkout was cancelled. Nothing was charged.")
          history.replaceState({}, "", "/account")
        }
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Vector could not load your account."))
      .finally(() => setLoading(false))
    return () => unsubscribe?.()
  }, [])

  const checkout = () => {
    if (!token || !terms) return
    setAction("checkout")
    setError("")
    void fetch("/api/billing/checkout", {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ plan, termsAccepted: terms }),
    })
      .then(async (response) => {
        const payload = await readAccountApiResponse(response, "Vector could not open checkout.")
        if (typeof payload.url !== "string") throw new Error("Vector could not open checkout.")
        location.assign(payload.url)
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Vector could not open checkout.")
        setAction("")
      })
  }

  const portal = () => {
    if (!token) return
    setAction("portal")
    setError("")
    void fetch("/api/account/portal", {
      method: "POST",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        const payload = await readAccountApiResponse(response, "Vector could not open billing.")
        if (typeof payload.url !== "string") throw new Error("Vector could not open billing.")
        location.assign(payload.url)
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Vector could not open billing.")
        setAction("")
      })
  }

  const signOut = () => {
    setAction("signout")
    void vectorAccountClient()
      .then((client) => client.auth.signOut({ scope: "local" }))
      .finally(() => location.replace("/login"))
  }

  const copyLicense = () => {
    if (!account?.billing?.licenseKey) return
    void navigator.clipboard.writeText(account.billing.licenseKey).then(() => setCopied(true))
  }

  if (loading) {
    return (
      <main className="account-loading">
        <LoaderCircle size={28} />
        <p>Loading your Vector account…</p>
      </main>
    )
  }

  const billing = account?.billing
  const standing = account?.betaAccess ? "Free during beta" : billing?.status.access ? "Licensed" : "License required"

  return (
    <main className="acct">
      <header className="acct-header">
        <div className="acct-header-inner">
          <a className="acct-brand" href="/" aria-label="Vector home">
            <img src="/vector-logo.png" alt="" />
            <span>Vector</span>
          </a>
          <nav aria-label="Account navigation">
            <a href="/docs">Docs</a>
            <a href="/releases">Releases</a>
            <button type="button" onClick={signOut} disabled={Boolean(action)}>
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <div className="acct-body">
        <h1>Account</h1>
        <p className="acct-meta">
          {account?.user.email}
          <span aria-hidden="true"> · </span>
          <span className="acct-standing" data-ok={account?.betaAccess || billing?.status.access ? "true" : "false"}>
            {standing}
          </span>
        </p>

        {notice && <p className="account-notice">{notice}</p>}
        {error && <p className="account-error">{error}</p>}

        <section className="acct-section">
          <h2>{configuration.releaseVersion ? `Download Vector ${configuration.releaseVersion}` : "Download Vector"}</h2>
          <p>
            {downloadAllowed
              ? "Installers for macOS, Windows, and Linux."
              : "Choose a plan below to unlock the installers."}
          </p>
          <FreeDownload version={configuration.releaseVersion} accessToken={token} accessAllowed={downloadAllowed} />
        </section>

        <CliLaunchPanel
          accessToken={token}
          previewToken={props.preview ? "vct_eyJ2IjoxLCJzdWIiOiJwcmV2aWV3IiwiZXhwIjoxfQ.previewsignature0000000000000000000000" : undefined}
        />

        <section className="acct-section" id="billing">
          <h2>Plan &amp; billing</h2>
          {billing ? (
            <>
              <dl className="acct-rows">
                <div>
                  <dt>Status</dt>
                  <dd>
                    <span className="acct-dot" data-state={billing.status.state} aria-hidden="true" />
                    {billing.status.state.replace("_", " ")}
                  </dd>
                </div>
                <div>
                  <dt>Plan</dt>
                  <dd>
                    {billing.status.plan === "annual" ? "Annual" : "Monthly"} · renews{" "}
                    {billing.status.interval === "year" ? "yearly" : "monthly"}
                  </dd>
                </div>
                {billing.licenseKey && (
                  <div>
                    <dt>License key</dt>
                    <dd className="acct-code-row">
                      <code>{billing.licenseKey}</code>
                      <button type="button" onClick={copyLicense}>
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </dd>
                  </div>
                )}
              </dl>
              <button className="acct-button acct-button-secondary" type="button" onClick={portal} disabled={Boolean(action)}>
                {action === "portal" ? "Opening Stripe…" : "Manage billing"}
              </button>
              <p className="acct-fine">Invoices, payment method, and cancellation are handled by Stripe.</p>
            </>
          ) : (
            <>
              <p>
                {account?.betaAccess
                  ? "Vector is free while it's in beta. A paid plan is optional — it gives you a private license key and Stripe billing controls, and keeps access uninterrupted when public pricing begins."
                  : "Choose monthly or annual access. Your private license key and Stripe billing controls stay attached to this account."}
              </p>
              <div className="acct-plans" role="radiogroup" aria-label="Plan">
                {(configuration.plans ?? fallbackPlans).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={plan === item.id}
                    onClick={() => setPlan(item.id)}
                  >
                    <span>{item.id === "annual" ? "Annual" : "Monthly"}</span>
                    <strong>
                      ${item.priceUsd}
                      <small>/{item.interval}</small>
                    </strong>
                    {item.id === "annual" && <em>Save $21</em>}
                  </button>
                ))}
              </div>
              <label className="acct-terms">
                <input type="checkbox" checked={terms} onChange={(event) => setTerms(event.currentTarget.checked)} />
                <span>
                  I agree to the <a href="/legal/license">software license</a> and{" "}
                  <a href="/legal/terms">subscription terms</a>.
                </span>
              </label>
              <button
                className="acct-button"
                type="button"
                onClick={checkout}
                disabled={!terms || Boolean(action) || !account?.purchasesAvailable}
              >
                {action === "checkout"
                  ? "Opening checkout…"
                  : account?.purchasesAvailable
                    ? `Continue with ${plan}`
                    : "Purchases opening soon"}
              </button>
              <p className="acct-fine">Stripe handles payment. Your license key appears here and is emailed to you.</p>
            </>
          )}
        </section>

        <section className="acct-section">
          <h2>Account</h2>
          <dl className="acct-rows">
            <div>
              <dt>Email</dt>
              <dd>{account?.user.email}</dd>
            </div>
            {account?.user.name && (
              <div>
                <dt>Name</dt>
                <dd>{account.user.name}</dd>
              </div>
            )}
          </dl>
          <button className="acct-button acct-button-secondary" type="button" onClick={signOut} disabled={Boolean(action)}>
            Sign out
          </button>
        </section>
      </div>
    </main>
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function isBillingPlan(value: unknown): value is NonNullable<BillingConfig["plans"]>[number] {
  if (!isRecord(value)) return false
  return (
    (value.id === "monthly" || value.id === "annual") &&
    typeof value.priceUsd === "number" &&
    (value.interval === "month" || value.interval === "year")
  )
}

function isLicenseStatus(value: unknown): value is LicenseStatus {
  if (!isRecord(value)) return false
  return (
    typeof value.access === "boolean" &&
    ["active", "canceling", "grace", "expired", "past_due", "revoked"].includes(String(value.state)) &&
    (value.plan === "annual" || value.plan === "monthly") &&
    (value.interval === "year" || value.interval === "month")
  )
}

function isAccountState(value: Record<string, unknown>): value is AccountState {
  if (!isRecord(value.user)) return false
  if (typeof value.user.id !== "string" || typeof value.user.email !== "string") return false
  if (value.user.name !== undefined && typeof value.user.name !== "string") return false
  if (typeof value.purchasesAvailable !== "boolean" || typeof value.betaAccess !== "boolean") return false
  if (value.billing === undefined) return true
  if (!isRecord(value.billing) || !isLicenseStatus(value.billing.status)) return false
  return value.billing.licenseKey === undefined || typeof value.billing.licenseKey === "string"
}
