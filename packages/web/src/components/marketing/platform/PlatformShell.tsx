/** @jsxImportSource react */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import type { Session } from "@supabase/supabase-js"
import {
  CreditCard,
  Download,
  KeyRound,
  LogIn,
  LogOut,
  Settings,
  ShieldCheck,
  Sparkles,
  WandSparkles,
} from "lucide-react"
import { AccountView } from "./account-view"
import { BuilderWorkspace } from "./builder-workspace"
import { MatrixField } from "./matrix-field"
import { apiFetch, platformAuth, platformConfig, type PlatformConfig } from "./platform-client"
import { SettingsView } from "./settings-view"
import "./platform.css"

type Mode = "builder" | "account" | "downloads" | "settings"

type EntitlementStatus = {
  entitlement: {
    access: boolean
    state: string
    message?: string
    graceEndsAt?: string
  }
  billing: { available: boolean }
}

const destinations: Array<{ id: Mode; label: string; href: string; icon: typeof Sparkles }> = [
  { id: "builder", label: "Builder", href: "/account", icon: WandSparkles },
  { id: "account", label: "Billing", href: "/billing", icon: CreditCard },
  { id: "downloads", label: "Downloads", href: "/download", icon: Download },
  { id: "settings", label: "Settings", href: "/settings", icon: Settings },
]

const modeTitles: Record<Mode, string> = {
  builder: "Vector Builder",
  account: "Vector Billing",
  downloads: "Downloads",
  settings: "Settings",
}

function PlatformBackdrop(props: { children: ReactNode }) {
  return (
    <div className="platform-runtime">
      <MatrixField />
      {props.children}
    </div>
  )
}

function SignIn(props: { config?: PlatformConfig; error?: string; onSession: (session: Session) => void }) {
  const [intent, setIntent] = useState<"signin" | "signup">("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const oauthProviders = props.config?.auth.providers || []

  const resetPassword = async () => {
    if (!email.trim()) return setMessage("Enter your email address first.")
    setBusy(true)
    setMessage("")
    try {
      const auth = await platformAuth()
      const { error } = await auth.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: location.origin + "/account?recovery=1",
      })
      if (error) throw error
      setMessage("Check your email for a secure password-reset link.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not send the reset link.")
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage("")
    try {
      const auth = await platformAuth()
      const result =
        intent === "signin"
          ? await auth.auth.signInWithPassword({ email, password })
          : await auth.auth.signUp({
              email,
              password,
              options: { emailRedirectTo: location.origin + "/account" },
            })
      if (result.error) throw result.error
      if (result.data.session) props.onSession(result.data.session)
      else setMessage("Confirm your email, then return here to sign in.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not sign you in.")
    } finally {
      setBusy(false)
    }
  }

  const oauth = async (provider: "github" | "google") => {
    setBusy(true)
    setMessage("")
    try {
      const auth = await platformAuth()
      const { error } = await auth.auth.signInWithOAuth({
        provider,
        options: { redirectTo: location.origin + location.pathname + location.search },
      })
      if (error) throw error
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not start sign-in.")
      setBusy(false)
    }
  }

  if (props.error || (props.config && !props.config.auth.available)) {
    return (
      <PlatformBackdrop>
        <div className="platform-gate">
          <img src="/vector-logo.png" alt="" />
          <span className="platform-kicker">Account service</span>
          <h1>Vector accounts are being configured.</h1>
          <p>{props.error || "This deployment is missing its account environment variables."}</p>
          <a href="/">Return to Vector</a>
        </div>
      </PlatformBackdrop>
    )
  }

  return (
    <PlatformBackdrop>
      <div className="platform-auth-layout">
        <section className="platform-auth-copy">
          <a className="platform-brand" href="/">
            <img src="/vector-logo.png" alt="" />
            <span>Vector</span>
          </a>
          <span className="platform-kicker">Turn an idea into a working product</span>
          <h1>Describe it. Build it. Open the real app.</h1>
          <p>
            Vector creates a complete project in an isolated workspace, runs it, and gives you a live browser preview
            you can keep refining with the agent.
          </p>
          <div className="platform-auth-proof">
            <span>
              <Sparkles size={16} /> Prompt to working application
            </span>
            <span>
              <ShieldCheck size={16} /> Isolated execution with visible evidence
            </span>
            <span>
              <KeyRound size={16} /> Your model and tool credentials stay encrypted
            </span>
          </div>
        </section>
        <form className="platform-auth-form" onSubmit={submit}>
          <div className="platform-segmented" aria-label="Account action">
            <button type="button" data-active={intent === "signin"} onClick={() => setIntent("signin")}>
              Sign in
            </button>
            <button type="button" data-active={intent === "signup"} onClick={() => setIntent("signup")}>
              Create account
            </button>
          </div>
          <div className="platform-auth-heading">
            <LogIn size={18} />
            <div>
              <strong>{intent === "signin" ? "Welcome back" : "Create your Vector account"}</strong>
              <span>{intent === "signin" ? "Continue building." : "Start with one clear product idea."}</span>
            </div>
          </div>
          <label>
            Email
            <input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete={intent === "signin" ? "current-password" : "new-password"}
              minLength={8}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {intent === "signin" && (
              <button className="platform-reset-link" type="button" onClick={() => void resetPassword()} disabled={busy}>
                Forgot password?
              </button>
            )}
          </label>
          <button className="platform-primary" type="submit" disabled={busy}>
            {busy ? "Working..." : intent === "signin" ? "Sign in" : "Create account"}
          </button>
          {oauthProviders.length > 0 && (
            <>
              <div className="platform-divider">
                <span>or continue with</span>
              </div>
              <div className="platform-oauth">
                {oauthProviders.map((provider) => (
                  <button key={provider} type="button" onClick={() => void oauth(provider)} disabled={busy}>
                    {provider === "github" ? "GitHub" : "Google"}
                  </button>
                ))}
              </div>
            </>
          )}
          {message && <p className="platform-form-message">{message}</p>}
          <small>By continuing, you agree to Vector's terms, privacy policy, and software license.</small>
        </form>
      </div>
    </PlatformBackdrop>
  )
}

function ProductShell(props: { mode: Mode; session: Session; children: ReactNode }) {
  const email = props.session.user.email || "Vector account"
  return (
    <PlatformBackdrop>
      <div className="platform-product">
        <aside className="platform-product-nav">
          <a className="platform-brand" href="/">
            <img src="/vector-logo.png" alt="" />
            <span>Vector</span>
          </a>
          <p className="platform-nav-label">Account</p>
          <nav>
            {destinations.map((destination) => {
              const Icon = destination.icon
              return (
                <a key={destination.id} href={destination.href} data-active={props.mode === destination.id}>
                  <Icon size={16} />
                  <span>{destination.label}</span>
                </a>
              )
            })}
          </nav>
          <div className="platform-user">
            <span>{email.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{email}</strong>
              <small>Vector member</small>
            </div>
            <button
              type="button"
              title="Sign out"
              onClick={() =>
                platformAuth()
                  .then((auth) => auth.auth.signOut())
                  .then(() => location.assign("/"))
              }
            >
              <LogOut size={15} />
            </button>
          </div>
        </aside>
        <main className="platform-product-main">{props.children}</main>
      </div>
    </PlatformBackdrop>
  )
}

function SubscriptionGate(props: { status: EntitlementStatus }) {
  const grace = props.status.entitlement.state === "grace"
  return (
    <section className="platform-subscription-gate">
      <span className="platform-subscription-icon">
        <CreditCard size={20} />
      </span>
      <span className="platform-kicker">Vector membership</span>
      <h1>{grace ? "Your payment needs attention." : "Subscribe to open Vector Builder."}</h1>
      <p>{props.status.entitlement.message || "Vector Builder and protected desktop downloads share one membership."}</p>
      <div>
        <a className="platform-primary" href="/billing">
          {grace ? "Fix payment" : "Choose a plan"}
        </a>
        <a className="platform-secondary" href="/">
          Return to Vector
        </a>
      </div>
    </section>
  )
}

export function PlatformShell(props: { mode: Mode }) {
  const [session, setSession] = useState<Session | null>()
  const [config, setConfig] = useState<PlatformConfig>()
  const [account, setAccount] = useState<EntitlementStatus>()
  const [error, setError] = useState("")
  const title = useMemo(() => modeTitles[props.mode], [props.mode])

  useEffect(() => {
    document.title = title + " — Vector"
    let unsubscribe = () => {}
    platformConfig()
      .then(async (value) => {
        setConfig(value)
        if (!value.auth.available) return setSession(null)
        const auth = await platformAuth()
        const { data } = await auth.auth.getSession()
        setSession(data.session)
        const listener = auth.auth.onAuthStateChange((_event, next) => setSession(next))
        unsubscribe = () => listener.data.subscription.unsubscribe()
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Vector could not load the account service.")
        setSession(null)
      })
    return () => unsubscribe()
  }, [title])

  useEffect(() => {
    if (!session) {
      setAccount(undefined)
      return
    }
    let active = true
    apiFetch("/api/account/status", session)
      .then((value) => {
        if (active) setAccount(value as EntitlementStatus)
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Vector could not verify your subscription.")
      })
    return () => {
      active = false
    }
  }, [session?.access_token])

  if (session === undefined && !error) {
    return (
      <PlatformBackdrop>
        <div className="platform-loading">
          <img src="/vector-logo.png" alt="" />
          <span>Opening Vector...</span>
        </div>
      </PlatformBackdrop>
    )
  }
  if (!session) return <SignIn config={config} error={error} onSession={setSession} />
  if (props.mode === "builder") {
    return (
      <PlatformBackdrop>
        {!account && !error && (
          <div className="platform-loading">
            <img src="/vector-logo.png" alt="" />
            <span>Opening Builder...</span>
          </div>
        )}
        {account && !account.entitlement.access && <SubscriptionGate status={account} />}
        {account?.entitlement.access && <BuilderWorkspace session={session} config={config} />}
      </PlatformBackdrop>
    )
  }
  return (
    <ProductShell mode={props.mode} session={session}>
      {props.mode === "account" && <AccountView session={session} config={config} />}
      {props.mode === "downloads" && <AccountView session={session} config={config} downloadsOnly />}
      {props.mode === "settings" && <SettingsView session={session} config={config} />}
    </ProductShell>
  )
}
