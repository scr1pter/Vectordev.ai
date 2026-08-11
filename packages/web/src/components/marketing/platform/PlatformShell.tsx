/** @jsxImportSource react */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import type { Session } from "@supabase/supabase-js"
import { Bot, Braces, Cloud, CreditCard, Download, KeyRound, LogIn, LogOut, ShieldCheck } from "lucide-react"
import { AccountView } from "./account-view"
import { CloudAgentsView } from "./cloud-agents-view"
import { PlayParkView } from "./play-park-view"
import { apiFetch, platformAuth, platformConfig, type PlatformConfig } from "./platform-client"
import "./platform.css"

type Mode = "account" | "agents" | "play-park" | "downloads"

type EntitlementStatus = {
  entitlement: {
    access: boolean
    state: string
    message?: string
    graceEndsAt?: string
  }
  billing: { available: boolean }
}

const destinations: Array<{ id: Mode; label: string; href: string; icon: typeof Cloud }> = [
  { id: "agents", label: "Cloud Agents", href: "/cloud-agents", icon: Bot },
  { id: "play-park", label: "Vector Play Park", href: "/api-studio", icon: Braces },
  { id: "downloads", label: "Downloads", href: "/download", icon: Download },
  { id: "account", label: "Account", href: "/account", icon: KeyRound },
]

function SignIn(props: { config?: PlatformConfig; error?: string; onSession: (session: Session) => void }) {
  const [intent, setIntent] = useState<"signin" | "signup">("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const oauthProviders = props.config?.auth.providers || []

  const resetPassword = async () => {
    if (!email.trim()) {
      setMessage("Enter your email address first, then request a reset link.")
      return
    }
    setBusy(true)
    setMessage("")
    try {
      const auth = await platformAuth()
      const { error } = await auth.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${location.origin}/account?recovery=1`,
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
          : await auth.auth.signUp({ email, password, options: { emailRedirectTo: `${location.origin}/account` } })
      if (result.error) throw result.error
      if (result.data.session) props.onSession(result.data.session)
      else setMessage("Check your email to confirm your Vector account, then return here to sign in.")
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
        options: { redirectTo: `${location.origin}${location.pathname}${location.search}` },
      })
      if (error) throw error
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not start sign-in.")
      setBusy(false)
    }
  }

  if (props.error || (props.config && !props.config.auth.available)) {
    return (
      <div className="platform-gate">
        <img src="/vector-logo.png" alt="" />
        <span className="platform-kicker">Account service</span>
        <h1>Vector accounts are being configured.</h1>
        <p>
          {props.error ||
            "The application is installed correctly, but this deployment is missing its account environment variables."}
        </p>
        <a href="/">Return to Vector</a>
      </div>
    )
  }

  return (
    <div className="platform-auth-layout">
      <section className="platform-auth-copy">
        <a className="platform-brand" href="/">
          <img src="/vector-logo.png" alt="" />
          <span>Vector</span>
        </a>
        <span className="platform-kicker">One account. Every Vector surface.</span>
        <h1>Build locally. Run continuously in the cloud.</h1>
        <p>
          Use the desktop workspace, isolated cloud agents, the API platform, and every supported installer through one
          subscription.
        </p>
        <div className="platform-auth-proof">
          <span>
            <ShieldCheck size={16} /> Subscription and license stay synchronized
          </span>
          <span>
            <Cloud size={16} /> Cloud runs remain isolated by workspace
          </span>
          <span>
            <KeyRound size={16} /> Saved connection credentials are encrypted at rest
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
            <span>
              {intent === "signin"
                ? "Continue where you left off."
                : "Your subscription unlocks every product surface."}
            </span>
          </div>
        </div>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
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
            <button className="platform-reset-link" type="button" onClick={resetPassword} disabled={busy}>
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
                <button key={provider} type="button" onClick={() => oauth(provider)} disabled={busy}>
                  {provider === "github" ? "GitHub" : "Google"}
                </button>
              ))}
            </div>
          </>
        )}
        {message && <p className="platform-form-message">{message}</p>}
        <small>
          By continuing, you agree to Vector's license, subscription terms, privacy policy, and acceptable-use rules.
        </small>
      </form>
    </div>
  )
}

function ProductShell(props: { mode: Mode; session: Session; children: ReactNode }) {
  const email = props.session.user.email || "Vector account"
  return (
    <div className="platform-product">
      <aside className="platform-product-nav">
        <a className="platform-brand" href="/">
          <img src="/vector-logo.png" alt="" />
          <span>Vector</span>
        </a>
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
      <h1>{grace ? "Your payment needs attention." : "Subscribe to open this Vector workspace."}</h1>
      <p>
        {props.status.entitlement.message ||
          "Cloud Agents, Vector Play Park, API access, and protected downloads are included with one Vector subscription."}
      </p>
      <div>
        <a className="platform-primary" href="/account">
          {grace ? "Fix payment" : "Choose a plan"}
        </a>
        <a className="platform-secondary" href="/">
          Return to Vector
        </a>
      </div>
      {!props.status.billing.available && (
        <small>Checkout is temporarily unavailable while billing is being configured.</small>
      )}
    </section>
  )
}

export function PlatformShell(props: { mode: Mode }) {
  const [session, setSession] = useState<Session | null>()
  const [config, setConfig] = useState<PlatformConfig>()
  const [account, setAccount] = useState<EntitlementStatus>()
  const [error, setError] = useState("")
  const title = useMemo(() => destinations.find((item) => item.id === props.mode)?.label || "Vector", [props.mode])

  useEffect(() => {
    document.title = `${title} — Vector`
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
    if (!session || props.mode === "account" || props.mode === "downloads") {
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
  }, [session?.access_token, props.mode])

  if (session === undefined && !error)
    return (
      <div className="platform-loading">
        <img src="/vector-logo.png" alt="" />
        <span>Opening Vector...</span>
      </div>
    )
  if (!session) return <SignIn config={config} error={error} onSession={setSession} />
  const protectedWorkspace = props.mode === "agents" || props.mode === "play-park"
  return (
    <ProductShell mode={props.mode} session={session}>
      {protectedWorkspace && !account && !error && (
        <div className="platform-loading">
          <img src="/vector-logo.png" alt="" />
          <span>Verifying your Vector access...</span>
        </div>
      )}
      {protectedWorkspace && account && !account.entitlement.access && <SubscriptionGate status={account} />}
      {props.mode === "agents" && account?.entitlement.access && <CloudAgentsView session={session} config={config} />}
      {props.mode === "play-park" && account?.entitlement.access && <PlayParkView session={session} config={config} />}
      {(props.mode === "account" || props.mode === "downloads") && (
        <AccountView session={session} config={config} downloadsOnly={props.mode === "downloads"} />
      )}
      {error && protectedWorkspace && (
        <div className="platform-gate">
          <span className="platform-kicker">Account service</span>
          <h1>Vector could not verify this workspace.</h1>
          <p>{error}</p>
          <a href="/account">Open account</a>
        </div>
      )}
    </ProductShell>
  )
}
