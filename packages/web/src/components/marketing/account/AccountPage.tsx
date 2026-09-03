/** @jsxImportSource react */
import {
  Check,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  LoaderCircle,
  LogOut,
  ShieldCheck,
  Sparkles,
} from "lucide-react"
import { useEffect, useState } from "react"
import { readAccountApiResponse, takeAccountReturnPath, vectorAccountClient } from "../../../lib/account-client"
import { FreeDownload } from "../purchase/FreeDownload"
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
    void navigator.clipboard.writeText(account.billing.licenseKey).then(() => setNotice("License key copied."))
  }

  if (loading) {
    return (
      <main className="account-loading">
        <LoaderCircle size={28} />
        <p>Loading your Vector account…</p>
      </main>
    )
  }

  return (
    <main className="account-page">
      <header className="account-topbar">
        <div className="account-topbar-inner">
          <a className="account-wordmark" href="/" aria-label="Vector home">
            <img src="/vector-logo.png" alt="" />
            <span>Vector</span>
          </a>
          <nav aria-label="Account navigation">
            <a href="/docs">Docs</a>
            <a href="/releases">Releases</a>
            <a href="#billing">Billing</a>
            <button type="button" onClick={signOut} disabled={Boolean(action)}>
              <LogOut size={15} /> Sign out
            </button>
          </nav>
        </div>
      </header>

      <div className="account-content">
        <section className="account-welcome">
          <div className="account-identity">
            <span className="account-avatar" aria-hidden="true">
              {(account?.user.name ?? account?.user.email ?? "V").slice(0, 1).toUpperCase()}
            </span>
            <div>
              <p className="account-kicker">Vector account</p>
              <h1>Welcome{account?.user.name ? `, ${account.user.name.split(" ")[0]}` : ""}.</h1>
              <span>{account?.user.email}</span>
            </div>
          </div>
          <div className="beta-badge">
            <Sparkles size={15} />
            <span>
              <strong>
                {account?.betaAccess
                  ? "Private beta"
                  : account?.billing?.status.access
                    ? "Licensed"
                    : "License required"}
              </strong>
              {account?.betaAccess
                ? "Desktop access is free right now"
                : account?.billing?.status.access
                  ? "Your paid access is active"
                  : "Choose a plan to download"}
            </span>
          </div>
        </section>

        {notice && <p className="account-notice">{notice}</p>}
        {error && <p className="account-error">{error}</p>}

        <section className="account-grid">
          <article className="account-panel download-panel">
            <div className="panel-heading">
              <span className="panel-icon">
                <Download size={18} />
              </span>
              <div>
                <p>Desktop app</p>
                <h2>{configuration.releaseVersion ? `Download Vector ${configuration.releaseVersion}` : "Download Vector"}</h2>
              </div>
            </div>
            <p className="panel-copy">
              {downloadAllowed
                ? "Your account unlocks every supported installer. Pick the build for this computer or open the full platform list."
                : "Choose an active Vector plan to unlock the installers for every supported platform."}
            </p>
            <FreeDownload version={configuration.releaseVersion} accessToken={token} accessAllowed={downloadAllowed} />
          </article>

          <article className="account-panel license-panel" id={account?.billing ? "billing" : undefined}>
            <div className="panel-heading">
              <span className="panel-icon">
                <ShieldCheck size={18} />
              </span>
              <div>
                <p>Access</p>
                <h2>{account?.billing ? "Your paid license" : "Private-beta access"}</h2>
              </div>
            </div>
            {account?.billing ? (
              <>
                <div className="license-status">
                  <span data-state={account.billing.status.state}></span>
                  <strong>{account.billing.status.state.replace("_", " ")}</strong>
                  <small>
                    {account.billing.status.plan} · renews{" "}
                    {account.billing.status.interval === "year" ? "yearly" : "monthly"}
                  </small>
                </div>
                {account.billing.licenseKey && (
                  <div className="account-license-key">
                    <span>License key</span>
                    <code>{account.billing.licenseKey}</code>
                    <button type="button" onClick={copyLicense}>
                      <Copy size={15} /> Copy
                    </button>
                  </div>
                )}
                <button className="account-secondary" type="button" onClick={portal} disabled={Boolean(action)}>
                  <CreditCard size={16} />
                  {action === "portal" ? "Opening Stripe…" : "Manage billing"}
                  <ExternalLink size={14} />
                </button>
              </>
            ) : (
              <div className="free-access">
                <strong>{account?.betaAccess ? "Free during private beta" : "Choose a Vector plan"}</strong>
                <p>
                  {account?.betaAccess
                    ? "You can download and use Vector now. A paid license is optional until public pricing begins."
                    : "Paid access is active for this release channel. Choose a monthly or annual plan to download and activate Vector."}
                </p>
                <ul>
                  <li>
                    <Check size={15} /> Account-gated installers
                  </li>
                  <li>
                    <Check size={15} /> Installers for every platform
                  </li>
                  <li>
                    <Check size={15} /> No change to your local model keys or repositories
                  </li>
                </ul>
              </div>
            )}
          </article>
        </section>

        {!account?.billing && (
          <section className="purchase-account" id="billing">
            <div className="purchase-account-copy">
              <p className="account-kicker">{account?.betaAccess ? "Optional during beta" : "Vector access"}</p>
              <h2>Choose your Vector license.</h2>
              <p>
                {account?.betaAccess
                  ? "Vector remains free for beta accounts today. Purchase when you want a private license key, Stripe billing controls, and uninterrupted paid access as public pricing turns on."
                  : "Choose monthly or annual access. Your private VEC1 license key and Stripe billing controls stay attached to this account."}
              </p>
            </div>
            <div className="account-plan-grid">
              {(configuration.plans ?? fallbackPlans).map((item) => (
                <button key={item.id} type="button" aria-pressed={plan === item.id} onClick={() => setPlan(item.id)}>
                  <span>{item.id === "annual" ? "Annual" : "Monthly"}</span>
                  <strong>
                    ${item.priceUsd}
                    <small>/{item.interval}</small>
                  </strong>
                  {item.id === "annual" && <i>Save $21</i>}
                </button>
              ))}
            </div>
            <label className="account-terms">
              <input type="checkbox" checked={terms} onChange={(event) => setTerms(event.currentTarget.checked)} />
              <span>
                I agree to the <a href="/legal/license">software license</a> and{" "}
                <a href="/legal/terms">subscription terms</a>.
              </span>
            </label>
            <button
              className="account-purchase"
              type="button"
              onClick={checkout}
              disabled={!terms || Boolean(action) || !account?.purchasesAvailable}
            >
              <CreditCard size={16} />
              {action === "checkout"
                ? "Opening secure checkout…"
                : account?.purchasesAvailable
                  ? `Continue with ${plan}`
                  : "Purchases opening soon"}
            </button>
            <p className="account-stripe">
              Stripe handles payment. The unique VEC1 license key is shown here and emailed to you.
            </p>
          </section>
        )}
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
