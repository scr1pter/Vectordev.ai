/** @jsxImportSource react */
import { useEffect, useState } from "react"
import { readAccountApiResponse, rememberAccountReturnPath, vectorAccountClient } from "../../../lib/account-client"
import { GoogleMark } from "../account/AuthPage"
import "../account/account.css"

type State = { kind: "loading" } | { kind: "signin" } | { kind: "denied"; message: string } | { kind: "opening" }

// The private Design Lab's door. The server decides who may enter (the owner's account,
// signed in with Google); this page only starts the Google sign-in and asks for the cookie.
export function DesignGate() {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [error, setError] = useState("")

  useEffect(() => {
    void vectorAccountClient()
      .then((client) => client.auth.getSession())
      .then(async ({ data }) => {
        if (!data.session) return setState({ kind: "signin" })
        setState({ kind: "opening" })
        const response = await fetch("/api/design-lab/session", {
          method: "POST",
          headers: { authorization: `Bearer ${data.session.access_token}`, accept: "application/json" },
        })
        if (response.status === 403) {
          const payload = await response.json().catch(() => undefined)
          const message = payload?.error?.message
          return setState({ kind: "denied", message: typeof message === "string" ? message : "Not available." })
        }
        const opened = await readAccountApiResponse(response, "The Design Lab could not open.")
        location.replace(typeof opened.path === "string" ? opened.path : "/design-lab/index.html")
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Vector accounts are unavailable.")
        setState({ kind: "signin" })
      })
  }, [])

  const google = (fresh: boolean) => {
    setError("")
    rememberAccountReturnPath("/design")
    void vectorAccountClient()
      .then(async (client) => {
        if (fresh) await client.auth.signOut()
        const { error: authError } = await client.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: `${location.origin}/account` },
        })
        if (authError) throw authError
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Google sign-in could not start."))
  }

  return (
    <section className="auth-card" aria-labelledby="design-title">
      <div className="auth-form-mark" aria-hidden="true">
        <img src="/vector-logo.png" alt="" width="44" height="44" />
      </div>
      <p className="auth-form-eyebrow">PRIVATE</p>
      <h1 id="design-title">Design Lab</h1>
      {state.kind === "loading" && <p className="auth-sub">Checking your session…</p>}
      {state.kind === "opening" && <p className="auth-sub">Opening the Design Lab…</p>}
      {state.kind === "signin" && (
        <>
          <p className="auth-sub">Sign in with Google to continue.</p>
          <button className="google-button" type="button" onClick={() => google(false)}>
            <GoogleMark /> Continue with Google
          </button>
        </>
      )}
      {state.kind === "denied" && (
        <>
          <p className="auth-sub">{state.message}</p>
          <button className="google-button" type="button" onClick={() => google(true)}>
            <GoogleMark /> Use a different Google account
          </button>
        </>
      )}
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
