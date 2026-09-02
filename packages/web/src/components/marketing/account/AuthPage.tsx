/** @jsxImportSource react */
import { ArrowRight, Check, Eye, EyeOff, LockKeyhole, Mail } from "lucide-react"
import { type SubmitEventHandler, useEffect, useMemo, useState } from "react"
import {
  rememberAccountReturnPath,
  safeReturnPath,
  takeAccountReturnPath,
  vectorAccountClient,
} from "../../../lib/account-client"
import "./account.css"

type Mode = "signin" | "register"

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.4-.18-2.06H12v3.9h5.38a4.6 4.6 0 0 1-1.99 3.02v2.53h3.23c1.89-1.74 2.98-4.3 2.98-7.39Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.96-.9 6.62-2.38l-3.23-2.53c-.9.6-2.04.96-3.39.96-2.6 0-4.81-1.76-5.6-4.12H3.07v2.6A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.4 13.93A6 6 0 0 1 6.08 12c0-.67.12-1.32.32-1.93v-2.6H3.07A10 10 0 0 0 2 12c0 1.61.39 3.13 1.07 4.53l3.33-2.6Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.95c1.47 0 2.78.5 3.82 1.49l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.47l3.33 2.6c.79-2.36 3-4.12 5.6-4.12Z"
      />
    </svg>
  )
}

export function AuthPage() {
  const [mode, setMode] = useState<Mode>("signin")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [visible, setVisible] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const returnTo = useMemo(
    () => safeReturnPath(new URLSearchParams(globalThis.location?.search ?? "").get("returnTo")),
    [],
  )

  useEffect(() => {
    void vectorAccountClient()
      .then((client) => client.auth.getSession())
      .then(({ data }) => {
        if (data.session) location.replace(returnTo)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Vector accounts are unavailable."))
  }, [returnTo])

  const google = () => {
    setError("")
    setLoading(true)
    rememberAccountReturnPath(returnTo)
    void vectorAccountClient()
      .then((client) =>
        client.auth.signInWithOAuth({
          provider: "google",
          options: {
            redirectTo: `${location.origin}/account`,
          },
        }),
      )
      .then(({ error: authError }) => {
        if (authError) throw authError
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Google sign-in could not start.")
        setLoading(false)
      })
  }

  const submit: SubmitEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault()
    setError("")
    setNotice("")
    setLoading(true)
    rememberAccountReturnPath(returnTo)
    void vectorAccountClient()
      .then((client) =>
        mode === "signin"
          ? client.auth.signInWithPassword({ email, password })
          : client.auth.signUp({
              email,
              password,
              options: {
                data: { full_name: name.trim() },
                emailRedirectTo: `${location.origin}/account`,
              },
            }),
      )
      .then(({ data, error: authError }) => {
        if (authError) throw authError
        if (data.session) {
          takeAccountReturnPath()
          location.assign(returnTo)
          return
        }
        setNotice("Check your inbox to confirm your email, then come back to sign in.")
        setMode("signin")
        setLoading(false)
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Vector could not sign you in.")
        setLoading(false)
      })
  }

  return (
    <main className="auth-page">
      <section className="auth-story" aria-label="About Vector accounts">
        <a className="account-wordmark" href="/" aria-label="Vector home">
          <img src="/vector-logo.png" alt="" />
          <span>Vector</span>
        </a>
        <div>
          <p className="account-kicker">One account. Every Vector build.</p>
          <h1>Your workspace is ready when you are.</h1>
          <p className="auth-deck">
            Sign in once to download Vector, manage billing, and recover your license. Your repositories, model keys,
            memory, and agent work stay on your computer.
          </p>
          <ul className="auth-proof">
            <li>
              <Check size={16} /> Free desktop access during private beta
            </li>
            <li>
              <Check size={16} /> macOS, Windows, and Linux installers
            </li>
            <li>
              <Check size={16} /> Stripe billing and your existing private license key
            </li>
          </ul>
        </div>
        <p className="auth-local-note">Local-first by design · Account data secured by Supabase</p>
      </section>

      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-card-head">
          <p>{mode === "signin" ? "Welcome back" : "Join the private beta"}</p>
          <h2 id="auth-title">{mode === "signin" ? "Sign in to Vector" : "Create your Vector account"}</h2>
          <span>
            {mode === "signin"
              ? "Download, billing, and license access in one place."
              : "Vector is free during private beta."}
          </span>
        </div>

        <div className="auth-switch" role="tablist" aria-label="Account action">
          <button type="button" role="tab" aria-selected={mode === "signin"} onClick={() => setMode("signin")}>
            Sign in
          </button>
          <button type="button" role="tab" aria-selected={mode === "register"} onClick={() => setMode("register")}>
            Create account
          </button>
        </div>

        <button className="google-button" type="button" onClick={google} disabled={loading}>
          <GoogleMark /> Continue with Google
        </button>

        <div className="auth-divider">
          <span>or continue with email</span>
        </div>

        <form className="auth-form" onSubmit={submit}>
          {mode === "register" && (
            <label>
              <span>Name</span>
              <div className="auth-input">
                <input
                  value={name}
                  onInput={(event) => setName(event.currentTarget.value)}
                  autoComplete="name"
                  placeholder="Your name"
                  required
                />
              </div>
            </label>
          )}
          <label>
            <span>Email</span>
            <div className="auth-input">
              <Mail size={16} />
              <input
                type="email"
                value={email}
                onInput={(event) => setEmail(event.currentTarget.value)}
                autoComplete="email"
                placeholder="you@example.com"
                required
              />
            </div>
          </label>
          <label>
            <span>Password</span>
            <div className="auth-input">
              <LockKeyhole size={16} />
              <input
                type={visible ? "text" : "password"}
                value={password}
                onInput={(event) => setPassword(event.currentTarget.value)}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                minLength={8}
                placeholder="At least 8 characters"
                required
              />
              <button
                type="button"
                aria-label={visible ? "Hide password" : "Show password"}
                onClick={() => setVisible((value) => !value)}
              >
                {visible ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>

          {notice && <p className="auth-notice">{notice}</p>}
          {error && <p className="auth-error">{error}</p>}

          <button className="auth-submit" disabled={loading}>
            {loading ? "Please wait…" : mode === "signin" ? "Sign in" : "Create free account"}
            {!loading && <ArrowRight size={17} />}
          </button>
        </form>

        <p className="auth-legal">
          By continuing, you agree to Vector's <a href="/legal/terms">Terms</a> and{" "}
          <a href="/legal/privacy">Privacy Policy</a>.
        </p>
      </section>
    </main>
  )
}
