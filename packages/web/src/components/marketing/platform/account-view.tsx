/** @jsxImportSource react */
import { useEffect, useState } from "react"
import type { Session } from "@supabase/supabase-js"
import {
  Activity,
  ArrowRight,
  Bot,
  Braces,
  Check,
  Cloud,
  Copy,
  CreditCard,
  Download,
  Gauge,
  KeyRound,
  Laptop,
  Link2,
  Plus,
  Settings,
  Shield,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { apiFetch, formatDate, platformAuth, type PlatformConfig } from "./platform-client"

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

type ApiKey = {
  id: string
  name: string
  secret_prefix: string
  last_four: string
  scopes: string[]
  daily_unit_limit: number
  expires_at?: string
  last_used_at?: string
  created_at: string
  revoked_at?: string
}
type PlatformUsage = {
  periodDays: number
  apiRequests: number
  cloudRuns: number
  activeRuns: number
  completedRuns: number
  cloudTokens: number
  cloudCostUsd: number
  activeApiKeys: number
  connectedTools: number
  cloudLaunchesUsed: number
  cloudTurnsUsed: number
  apiExecutionsToday: number
  limits: {
    activeCloudAgents: number
    cloudAgentLaunches30Days: number
    cloudAgentTurns30Days: number
    apiExecutionsDaily: number
  }
}

const installers = [
  ["mac-arm64", "macOS", "Apple silicon"],
  ["mac-x64", "macOS", "Intel"],
  ["windows-x64", "Windows", "64-bit"],
  ["windows-arm64", "Windows", "ARM64"],
  ["linux-x64", "Linux", "x86_64 AppImage"],
  ["linux-arm64", "Linux", "ARM64 AppImage"],
] as const

export function AccountView(props: { session: Session; config?: PlatformConfig; downloadsOnly?: boolean }) {
  const [status, setStatus] = useState<AccountStatus>()
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [usage, setUsage] = useState<PlatformUsage>()
  const [newKey, setNewKey] = useState("")
  const [licenseKey, setLicenseKey] = useState("")
  const [keyName, setKeyName] = useState("Production")
  const [keyScopes, setKeyScopes] = useState(["agents:read", "agents:write", "api:execute"])
  const [keyDailyLimit, setKeyDailyLimit] = useState(500)
  const [keyExpiryDays, setKeyExpiryDays] = useState(90)
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [recoveryPassword, setRecoveryPassword] = useState("")
  const [busy, setBusy] = useState("")
  const [message, setMessage] = useState("")

  const load = async () => {
    setMessage("")
    try {
      const account = (await apiFetch("/api/account/status", props.session)) as AccountStatus
      setStatus(account)
      if (account.entitlement.access && !props.downloadsOnly) {
        const [keyPayload, usagePayload] = await Promise.all([
          apiFetch<{ keys: ApiKey[] }>("/api/platform/api-keys", props.session),
          apiFetch("/api/platform/usage", props.session),
        ])
        setKeys(keyPayload.keys || [])
        setUsage(usagePayload as PlatformUsage)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not load your account.")
    }
  }

  useEffect(() => {
    void load()
  }, [props.session.access_token, props.downloadsOnly])

  useEffect(() => {
    const checkoutSession = new URLSearchParams(location.search).get("session_id")
    if (!checkoutSession) return
    setBusy("claim")
    apiFetch<{ licenseKey?: string }>(
      `/api/billing/claim?session_id=${encodeURIComponent(checkoutSession)}`,
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
      setMessage("Accept Vector's license, subscription terms, privacy policy, and acceptable-use rules to continue.")
      return
    }
    setBusy(`checkout-${plan}`)
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

  const download = async (target: string) => {
    setBusy(`download-${target}`)
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

  const portal = async () => {
    setBusy("portal")
    try {
      const payload = await apiFetch<{ url: string }>("/api/account/portal", props.session, { method: "POST" })
      location.assign(payload.url)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not open billing.")
      setBusy("")
    }
  }

  const createKey = async () => {
    setBusy("key")
    setNewKey("")
    try {
      const payload = await apiFetch<{ secret: string }>("/api/platform/api-keys", props.session, {
        method: "POST",
        body: JSON.stringify({
          name: keyName,
          scopes: keyScopes,
          dailyUnitLimit: keyDailyLimit,
          expiresInDays: keyExpiryDays,
        }),
      })
      setNewKey(payload.secret)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not create the API key.")
    } finally {
      setBusy("")
    }
  }

  const revokeKey = async (id: string) => {
    setBusy(id)
    try {
      await apiFetch("/api/platform/api-keys", props.session, { method: "DELETE", body: JSON.stringify({ id }) })
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not revoke the API key.")
    } finally {
      setBusy("")
    }
  }

  const finishRecovery = async () => {
    if (recoveryPassword.length < 8) {
      setMessage("Use at least eight characters for your new password.")
      return
    }
    setBusy("recovery")
    setMessage("")
    try {
      const auth = await platformAuth()
      const { error } = await auth.auth.updateUser({ password: recoveryPassword })
      if (error) throw error
      setRecoveryPassword("")
      history.replaceState({}, "", "/account")
      setMessage("Your Vector password has been updated.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not update your password.")
    } finally {
      setBusy("")
    }
  }

  const entitled = status?.entitlement.access
  return (
    <div className="platform-page account-page">
      <header className="platform-page-header">
        <div className="platform-page-title">
          <span>{props.downloadsOnly ? <Download size={17} /> : <Shield size={17} />}</span>
          <div>
            <h1>{props.downloadsOnly ? "Downloads" : "Account & access"}</h1>
            <p>
              {props.downloadsOnly
                ? "Install Vector on a supported computer."
                : "Subscription, licenses, downloads, and developer access."}
            </p>
          </div>
        </div>
        {status && (
          <span className="platform-status" data-state={status.entitlement.state}>
            {status.entitlement.state.replace("_", " ")}
          </span>
        )}
      </header>
      <div className="account-content">
        {!props.downloadsOnly && (
          <section className="account-command-hero">
            <div className="account-command-copy">
              <span className="platform-kicker">
                <Sparkles size={13} /> Vector command center
              </span>
              <h2>One account for every way you build.</h2>
              <p>
                Move from the desktop workspace to persistent cloud builders, test the same runtime through the API
                platform, and keep access, usage, installers, and billing together.
              </p>
              <div className="account-command-actions">
                <a className="platform-primary" href="/cloud-agents">
                  Open Cloud Agents <ArrowRight size={15} />
                </a>
                <a className="platform-secondary" href="/api-studio">
                  Open API Platform <ArrowRight size={15} />
                </a>
              </div>
            </div>
            <div className="account-orbit" aria-hidden="true">
              <span>
                <img src="/vector-logo.png" alt="" />
              </span>
              <i></i>
              <i></i>
              <i></i>
            </div>
          </section>
        )}
        {!props.downloadsOnly && (
          <section className="account-product-grid" aria-label="Vector products">
            <a href="/cloud-agents">
              <span className="account-product-icon">
                <Bot size={18} />
              </span>
              <small>Continuous execution</small>
              <strong>Cloud Agents</strong>
              <p>Launch coordinated or isolated builders that keep working in persistent cloud sandboxes.</p>
              <span className="account-product-open">
                Open workspace <ArrowRight size={14} />
              </span>
            </a>
            <a href="/api-studio">
              <span className="account-product-icon">
                <Braces size={18} />
              </span>
              <small>Programmable runtime</small>
              <strong>API Platform</strong>
              <p>Design, execute, assert, save, and automate requests with logs and evidence attached.</p>
              <span className="account-product-open">
                Open platform <ArrowRight size={14} />
              </span>
            </a>
            <a href="/download">
              <span className="account-product-icon">
                <Laptop size={18} />
              </span>
              <small>Local-first workspace</small>
              <strong>Vector Desktop</strong>
              <p>Build with your repositories, models, editor, terminal, browser, cloud controls, and agent teams.</p>
              <span className="account-product-open">
                View installers <ArrowRight size={14} />
              </span>
            </a>
            <a href="/settings">
              <span className="account-product-icon">
                <Settings size={18} />
              </span>
              <small>One membership</small>
              <strong>Account Settings</strong>
              <p>Manage your identity, security, subscription, and access from a dedicated settings surface.</p>
              <span className="account-product-open">
                Open settings <ArrowRight size={14} />
              </span>
            </a>
          </section>
        )}
        {!props.downloadsOnly && status && (
          <section className="account-system-strip">
            <span>
              <Cloud size={15} />
              <strong>{props.config?.services.cloudAgents ? "Cloud ready" : "Cloud setup"}</strong>
              <small>Agents</small>
            </span>
            <span>
              <Gauge size={15} />
              <strong>{props.config?.services.apiPlatform ? "Runtime ready" : "Runtime setup"}</strong>
              <small>API Platform</small>
            </span>
            <span>
              <Shield size={15} />
              <strong>{status.entitlement.access ? "Unlocked" : "Plan required"}</strong>
              <small>Membership</small>
            </span>
            <span>
              <KeyRound size={15} />
              <strong>{(usage?.activeApiKeys || 0).toLocaleString()} active</strong>
              <small>API keys</small>
            </span>
          </section>
        )}
        {new URLSearchParams(location.search).get("recovery") === "1" && (
          <section className="account-recovery">
            <div>
              <span className="platform-kicker">Account recovery</span>
              <h2>Choose a new password.</h2>
              <p>This resets the password for your signed-in Vector account.</p>
            </div>
            <input
              className="platform-input"
              type="password"
              minLength={8}
              autoComplete="new-password"
              value={recoveryPassword}
              onChange={(event) => setRecoveryPassword(event.target.value)}
              placeholder="New password"
            />
            <button className="platform-primary" onClick={finishRecovery} disabled={busy === "recovery"}>
              {busy === "recovery" ? "Updating..." : "Update password"}
            </button>
          </section>
        )}
        {licenseKey && (
          <section className="account-license-ready">
            <div>
              <span>
                <Check size={15} /> Purchase verified
              </span>
              <h2>Your Vector license is ready.</h2>
              <p>Keep this key private. It activates one computer at a time and remains tied to this account.</p>
            </div>
            <code>{licenseKey}</code>
            <button className="platform-secondary" onClick={() => navigator.clipboard.writeText(licenseKey)}>
              <Copy size={14} />
              Copy key
            </button>
            <button className="platform-icon-button" title="Hide license" onClick={() => setLicenseKey("")}>
              <X size={14} />
            </button>
          </section>
        )}
        {!status && !message && (
          <div className="platform-empty">
            <Shield size={28} />
            <h2>Checking your Vector access</h2>
            <p>Subscription and license details are loading.</p>
          </div>
        )}
        {status && !entitled && (
          <section className="account-purchase" id="membership">
            <div>
              <span className="platform-kicker">Vector membership</span>
              <h2>One subscription unlocks the complete platform.</h2>
              <p>
                Desktop apps, updates, Vector Play Park, API keys, isolated Cloud Agents, MCP connections, and the
                three-day monthly payment grace period.
              </p>
            </div>
            <div className="account-plans">
              <article>
                <span>Monthly</span>
                <strong>
                  $10<small>/month</small>
                </strong>
                <p>Flexible access with a three-day failed-payment grace period.</p>
                <button
                  className="platform-primary"
                  onClick={() => checkout("monthly")}
                  disabled={!!busy || !status.billing.available}
                >
                  {busy === "checkout-monthly" ? "Opening Stripe..." : "Choose monthly"}
                </button>
              </article>
              <article data-featured="true">
                <span>Annual</span>
                <strong>
                  $99<small>/year</small>
                </strong>
                <p>Two months less than monthly billing, renewed once per year.</p>
                <button
                  className="platform-primary"
                  onClick={() => checkout("annual")}
                  disabled={!!busy || !status.billing.available}
                >
                  {busy === "checkout-annual" ? "Opening Stripe..." : "Choose annual"}
                </button>
              </article>
            </div>
            <label className="account-terms">
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(event) => setTermsAccepted(event.target.checked)}
              />
              <span>
                I agree to Vector's <a href="/legal/terms">license, subscription, and acceptable-use terms</a> and{" "}
                <a href="/legal/privacy">privacy policy</a>.
              </span>
            </label>
            {status.canManageBilling && (
              <button className="platform-secondary account-fix-payment" onClick={portal} disabled={!!busy}>
                <CreditCard size={15} />
                Update payment or manage billing
              </button>
            )}
            {!status.billing.available && (
              <p className="account-warning">
                Purchases stay closed until account storage, Stripe, email delivery, and protected installers are all
                configured.
              </p>
            )}
          </section>
        )}
        {status && entitled && (
          <>
            {!props.downloadsOnly && (
              <section className="account-overview">
                <div className="account-overview-main">
                  <span className="platform-kicker">Current plan</span>
                  <h2>
                    {status.entitlement.plan === "founder"
                      ? "Founder access"
                      : status.entitlement.plan === "monthly"
                        ? "Vector monthly"
                        : "Vector annual"}
                  </h2>
                  <p>
                    {status.entitlement.message ||
                      (status.entitlement.plan === "founder"
                        ? "Founder access is active without a renewal date."
                        : `Access continues through ${formatDate(status.entitlement.expiresAt)}.`)}
                  </p>
                </div>
                <dl>
                  <div>
                    <dt>Status</dt>
                    <dd>{status.entitlement.state.replace("_", " ")}</dd>
                  </div>
                  <div>
                    <dt>Renews or expires</dt>
                    <dd>
                      {status.entitlement.plan === "founder"
                        ? "No expiration"
                        : formatDate(status.entitlement.expiresAt)}
                    </dd>
                  </div>
                  {status.entitlement.graceEndsAt && (
                    <div>
                      <dt>Grace period ends</dt>
                      <dd>{formatDate(status.entitlement.graceEndsAt)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Licensed devices</dt>
                    <dd>1 active computer</dd>
                  </div>
                </dl>
                {status.canManageBilling ? (
                  <button className="platform-secondary" onClick={portal} disabled={!!busy}>
                    <CreditCard size={15} />
                    Manage billing
                  </button>
                ) : (
                  <a className="platform-secondary" href="/settings">
                    <Settings size={15} />
                    Account settings
                  </a>
                )}
              </section>
            )}
            <section className="account-section">
              <div className="account-section-heading">
                <div>
                  <h2>Desktop installers</h2>
                  <p>
                    Your account is verified before every download. The same license activates one computer at a time.
                  </p>
                </div>
                <Laptop size={18} />
              </div>
              <div className="installer-grid">
                {installers.map(([target, family, label]) => (
                  <button key={target} onClick={() => download(target)} disabled={!!busy}>
                    <span>
                      <strong>{family}</strong>
                      <small>{label}</small>
                    </span>
                    <Download size={15} />
                  </button>
                ))}
              </div>
            </section>
            {!props.downloadsOnly && (
              <section className="account-section">
                <div className="account-section-heading">
                  <div>
                    <h2>Platform usage</h2>
                    <p>Measured from real API requests and cloud runs during the last 30 days.</p>
                  </div>
                  <Activity size={18} />
                </div>
                <div className="platform-usage-grid">
                  <div>
                    <span>
                      <Braces size={13} />
                      API requests
                    </span>
                    <strong>
                      {(usage?.apiExecutionsToday || 0).toLocaleString()} /{" "}
                      {(
                        usage?.limits.apiExecutionsDaily ||
                        props.config?.limits.apiExecutionsDaily ||
                        0
                      ).toLocaleString()}
                    </strong>
                    <small>{(usage?.apiRequests || 0).toLocaleString()} completed in the last 30 days</small>
                  </div>
                  <div>
                    <span>
                      <Bot size={13} />
                      Cloud launches
                    </span>
                    <strong>
                      {(usage?.cloudLaunchesUsed || 0).toLocaleString()} /{" "}
                      {(
                        usage?.limits.cloudAgentLaunches30Days ||
                        props.config?.limits.cloudAgentLaunches30Days ||
                        0
                      ).toLocaleString()}
                    </strong>
                    <small>
                      {usage?.activeRuns || 0} active · {usage?.completedRuns || 0} complete · rolling 30 days
                    </small>
                  </div>
                  <div>
                    <span>
                      <Activity size={13} />
                      Cloud tokens
                    </span>
                    <strong>{(usage?.cloudTokens || 0).toLocaleString()}</strong>
                    <small>${(usage?.cloudCostUsd || 0).toFixed(4)} provider cost reported</small>
                  </div>
                  <div>
                    <span>
                      <Link2 size={13} />
                      Developer access
                    </span>
                    <strong>{usage?.connectedTools || 0} tools</strong>
                    <small>
                      {usage?.activeApiKeys || 0} API keys · {usage?.cloudTurnsUsed || 0} cloud follow-ups
                    </small>
                  </div>
                </div>
              </section>
            )}
            {!props.downloadsOnly && (
              <section className="account-section">
                <div className="account-section-heading">
                  <div>
                    <h2>Vector API keys</h2>
                    <p>
                      Use these keys from servers and CI. The secret is shown once and stored only as a secure hash.
                    </p>
                  </div>
                  <KeyRound size={18} />
                </div>
                <div className="api-key-create">
                  <input
                    className="platform-input"
                    value={keyName}
                    onChange={(event) => setKeyName(event.target.value)}
                    aria-label="API key name"
                  />
                  <select
                    className="platform-input"
                    aria-label="API key expiry"
                    value={keyExpiryDays}
                    onChange={(event) => setKeyExpiryDays(Number(event.target.value))}
                  >
                    <option value={30}>30 days</option>
                    <option value={90}>90 days</option>
                    <option value={365}>1 year</option>
                  </select>
                  <input
                    className="platform-input"
                    type="number"
                    min={10}
                    max={10000}
                    aria-label="Daily API request limit"
                    value={keyDailyLimit}
                    onChange={(event) => setKeyDailyLimit(Number(event.target.value))}
                  />
                  <button className="platform-primary" onClick={createKey} disabled={!!busy || !keyScopes.length}>
                    <Plus size={14} />
                    Create key
                  </button>
                </div>
                <div className="api-key-scopes" aria-label="API key permissions">
                  {["agents:read", "agents:write", "api:execute"].map((scope) => (
                    <label key={scope}>
                      <input
                        type="checkbox"
                        checked={keyScopes.includes(scope)}
                        onChange={(event) =>
                          setKeyScopes((current) =>
                            event.target.checked ? [...current, scope] : current.filter((item) => item !== scope),
                          )
                        }
                      />
                      <span>{scope}</span>
                    </label>
                  ))}
                </div>
                {newKey && (
                  <div className="new-api-key">
                    <div>
                      <Check size={15} />
                      <span>Copy this key now. Vector cannot show it again.</span>
                    </div>
                    <code>{newKey}</code>
                    <button className="platform-secondary" onClick={() => navigator.clipboard.writeText(newKey)}>
                      <Copy size={14} />
                      Copy
                    </button>
                  </div>
                )}
                <div className="api-key-list">
                  {keys.length ? (
                    keys.map((key) => (
                      <div key={key.id}>
                        <span className="api-key-mark">
                          <KeyRound size={14} />
                        </span>
                        <div>
                          <strong>{key.name}</strong>
                          <code>
                            {key.secret_prefix}••••••{key.last_four}
                          </code>
                          <small>
                            {key.scopes.join(" · ")} · {key.daily_unit_limit}/day · expires {formatDate(key.expires_at)}
                          </small>
                        </div>
                        <small>
                          {key.last_used_at
                            ? `Used ${formatDate(key.last_used_at)}`
                            : `Created ${formatDate(key.created_at)}`}
                        </small>
                        <button
                          className="platform-icon-button"
                          title="Revoke API key"
                          onClick={() => revokeKey(key.id)}
                          disabled={busy === key.id || !!key.revoked_at}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="account-muted">No API keys yet.</p>
                  )}
                </div>
              </section>
            )}
          </>
        )}
        {message && <p className="account-message">{message}</p>}
      </div>
    </div>
  )
}
