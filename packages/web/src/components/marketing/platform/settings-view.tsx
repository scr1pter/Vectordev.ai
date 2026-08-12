/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react"
import type { Session } from "@supabase/supabase-js"
import { Drawer } from "vaul"
import {
  ArrowUpRight,
  Check,
  CreditCard,
  ExternalLink,
  KeyRound,
  LockKeyhole,
  LogOut,
  Mail,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react"
import { apiFetch, formatDate, platformAuth, type PlatformConfig } from "./platform-client"
import { PlatformButton } from "./platform-button"

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

function planName(status?: AccountStatus) {
  if (status?.entitlement.plan === "founder") return "Founder access"
  if (status?.entitlement.plan === "monthly") return "Vector monthly"
  if (status?.entitlement.plan === "annual") return "Vector annual"
  return "No active plan"
}

export function SettingsView(props: { session: Session; config?: PlatformConfig }) {
  const [status, setStatus] = useState<AccountStatus>()
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState("")
  const [message, setMessage] = useState("")
  const initials = useMemo(() => {
    const source = status?.user.name || status?.user.email || props.session.user.email || "V"
    return source
      .split(/\s|@/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("")
  }, [props.session.user.email, status])

  const load = async () => {
    try {
      const value = (await apiFetch("/api/account/status", props.session)) as AccountStatus
      setStatus(value)
      setName(value.user.name || "")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not load account settings.")
    }
  }

  useEffect(() => {
    void load()
  }, [props.session.access_token])

  const saveProfile = async () => {
    if (!name.trim()) return setMessage("Enter the name you want Vector to use.")
    setBusy("profile")
    setMessage("")
    try {
      const auth = await platformAuth()
      const { error } = await auth.auth.updateUser({ data: { full_name: name.trim(), name: name.trim() } })
      if (error) throw error
      await load()
      setMessage("Profile updated.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not update your profile.")
    } finally {
      setBusy("")
    }
  }

  const updatePassword = async () => {
    if (password.length < 8) return setMessage("Use at least eight characters for your new password.")
    setBusy("password")
    setMessage("")
    try {
      const auth = await platformAuth()
      const { error } = await auth.auth.updateUser({ password })
      if (error) throw error
      setPassword("")
      setMessage("Password updated.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not update your password.")
    } finally {
      setBusy("")
    }
  }

  const sendReset = async () => {
    const email = status?.user.email || props.session.user.email
    if (!email) return
    setBusy("reset")
    setMessage("")
    try {
      const auth = await platformAuth()
      const { error } = await auth.auth.resetPasswordForEmail(email, {
        redirectTo: `${location.origin}/settings?recovery=1`,
      })
      if (error) throw error
      setMessage("Password reset email sent.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not send the reset email.")
    } finally {
      setBusy("")
    }
  }

  const openBilling = async () => {
    setBusy("billing")
    setMessage("")
    try {
      const payload = await apiFetch<{ url: string }>("/api/account/portal", props.session, { method: "POST" })
      location.assign(payload.url)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not open billing.")
      setBusy("")
    }
  }

  const signOut = async (scope: "local" | "global" = "local") => {
    const auth = await platformAuth()
    await auth.auth.signOut({ scope })
    location.assign("/")
  }

  return (
    <div className="platform-page settings-page mx-auto w-full max-w-[1180px]">
      <header className="platform-page-header settings-header">
        <div className="platform-page-title">
          <span>
            <ShieldCheck size={17} />
          </span>
          <div>
            <h1>Settings</h1>
            <p>Identity, security, billing, and access for your Vector account.</p>
          </div>
        </div>
        <span className="platform-status" data-state={status?.entitlement.access ? "active" : "expired"}>
          {status?.entitlement.access ? "access active" : "plan required"}
        </span>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <a href="#profile">
            <UserRound size={15} /> Profile
          </a>
          <a href="#billing">
            <CreditCard size={15} /> Billing
          </a>
          <a href="#security">
            <LockKeyhole size={15} /> Security
          </a>
          <a href="#privacy">
            <ShieldCheck size={15} /> Data & legal
          </a>
        </nav>

        <div className="settings-content">
          <section id="profile" className="settings-card">
            <div className="settings-card-heading">
              <span>
                <UserRound size={17} />
              </span>
              <div>
                <h2>Profile</h2>
                <p>Shown across the Vector account and cloud workspaces.</p>
              </div>
            </div>
            <div className="settings-profile-row">
              <span className="settings-avatar">
                {status?.user.avatarUrl ? <img src={status.user.avatarUrl} alt="" /> : initials}
              </span>
              <div>
                <strong>{status?.user.name || "Vector member"}</strong>
                <small>{status?.user.email || props.session.user.email}</small>
              </div>
              <Drawer.Root>
                <Drawer.Trigger asChild>
                  <PlatformButton variant="secondary">Account actions</PlatformButton>
                </Drawer.Trigger>
                <Drawer.Portal>
                  <Drawer.Overlay className="settings-drawer-overlay" />
                  <Drawer.Content className="settings-drawer" aria-describedby="account-actions-description">
                    <div className="settings-drawer-handle" />
                    <div className="settings-drawer-heading">
                      <div>
                        <strong>Account actions</strong>
                        <p id="account-actions-description">Security controls for this Vector account.</p>
                      </div>
                      <Drawer.Close asChild>
                        <PlatformButton variant="icon" aria-label="Close">
                          <X size={15} />
                        </PlatformButton>
                      </Drawer.Close>
                    </div>
                    <button className="settings-drawer-action" onClick={() => void sendReset()}>
                      <Mail size={16} />
                      <span>
                        <strong>Send password reset</strong>
                        <small>Email a secure recovery link.</small>
                      </span>
                    </button>
                    <button className="settings-drawer-action" onClick={() => void signOut("local")}>
                      <LogOut size={16} />
                      <span>
                        <strong>Sign out here</strong>
                        <small>End this browser session.</small>
                      </span>
                    </button>
                    <button className="settings-drawer-action danger" onClick={() => void signOut("global")}>
                      <LockKeyhole size={16} />
                      <span>
                        <strong>Sign out everywhere</strong>
                        <small>End every active Vector web session.</small>
                      </span>
                    </button>
                  </Drawer.Content>
                </Drawer.Portal>
              </Drawer.Root>
            </div>
            <div className="settings-fields">
              <label>
                <span>Display name</span>
                <input className="platform-input" value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label>
                <span>Email</span>
                <input
                  className="platform-input"
                  value={status?.user.email || props.session.user.email || ""}
                  disabled
                />
              </label>
            </div>
            <div className="settings-actions">
              <PlatformButton variant="primary" onClick={() => void saveProfile()} disabled={!!busy}>
                <Check size={15} /> {busy === "profile" ? "Saving..." : "Save profile"}
              </PlatformButton>
            </div>
          </section>

          <section id="billing" className="settings-card">
            <div className="settings-card-heading">
              <span>
                <CreditCard size={17} />
              </span>
              <div>
                <h2>Billing & subscription</h2>
                <p>Website and desktop access share the same Vector membership.</p>
              </div>
            </div>
            <div className="settings-plan">
              <div>
                <span>Current access</span>
                <strong>{planName(status)}</strong>
                <small>
                  {status?.entitlement.message ||
                    (status?.entitlement.plan === "founder"
                      ? "Founder access does not expire."
                      : status?.entitlement.expiresAt
                        ? `Renews or expires ${formatDate(status.entitlement.expiresAt)}`
                        : "Choose a plan from your account home.")}
                </small>
              </div>
              <span className="platform-status" data-state={status?.entitlement.state || "expired"}>
                {status?.entitlement.state || "loading"}
              </span>
            </div>
            <div className="settings-actions">
              {status?.canManageBilling ? (
                <PlatformButton variant="primary" onClick={() => void openBilling()} disabled={!!busy}>
                  <CreditCard size={15} /> {busy === "billing" ? "Opening Stripe..." : "Manage billing"}
                </PlatformButton>
              ) : (
                <a className="platform-primary" href="/account#membership">
                  <CreditCard size={15} /> View plans
                </a>
              )}
              <a className="platform-secondary" href="/account">
                <ArrowUpRight size={15} /> Account overview
              </a>
            </div>
          </section>

          <section id="security" className="settings-card">
            <div className="settings-card-heading">
              <span>
                <KeyRound size={17} />
              </span>
              <div>
                <h2>Password & security</h2>
                <p>Google sign-in remains available even if you also set a password.</p>
              </div>
            </div>
            <div className="settings-inline-form">
              <input
                className="platform-input"
                type="password"
                minLength={8}
                autoComplete="new-password"
                placeholder="New password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <PlatformButton variant="secondary" onClick={() => void updatePassword()} disabled={!!busy}>
                {busy === "password" ? "Updating..." : "Update password"}
              </PlatformButton>
              <PlatformButton variant="secondary" onClick={() => void sendReset()} disabled={!!busy}>
                {busy === "reset" ? "Sending..." : "Email reset link"}
              </PlatformButton>
            </div>
          </section>

          <section id="privacy" className="settings-card">
            <div className="settings-card-heading">
              <span>
                <ShieldCheck size={17} />
              </span>
              <div>
                <h2>Data & legal</h2>
                <p>Understand how account, billing, cloud, and local workspace data are handled.</p>
              </div>
            </div>
            <div className="settings-link-grid">
              <a href="/legal/privacy">
                Privacy policy <ExternalLink size={14} />
              </a>
              <a href="/legal/terms">
                Subscription terms <ExternalLink size={14} />
              </a>
              <a href="/legal/license">
                Software license <ExternalLink size={14} />
              </a>
              <a href="/legal/third-party">
                Third-party notices <ExternalLink size={14} />
              </a>
            </div>
          </section>
          {message && <p className="account-message settings-message">{message}</p>}
        </div>
      </div>
    </div>
  )
}
