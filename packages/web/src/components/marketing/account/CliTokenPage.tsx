/** @jsxImportSource react */
import { Check, Copy, LoaderCircle, RefreshCw, TerminalSquare } from "lucide-react"
import { useEffect, useState } from "react"
import { readAccountApiResponse, vectorAccountClient } from "../../../lib/account-client"
import "./account.css"

/**
 * /auth/cli — pairs the Vector CLI with a Vector account. Signed-in users get
 * a vct_ token to paste into `vector login`; everyone else bounces to /login.
 */
export function CliTokenPage() {
  const [token, setToken] = useState("")
  const [email, setEmail] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  // Always read the live session: Supabase rotates access tokens, so a token
  // captured at mount goes stale and would 401 on "New token".
  const mint = async () => {
    setError("")
    const client = await vectorAccountClient()
    const session = await client.auth.getSession()
    if (session.error) throw session.error
    if (!session.data.session) {
      location.replace(`/login?returnTo=${encodeURIComponent("/auth/cli")}`)
      return
    }
    setEmail(session.data.session.user.email ?? "")
    const response = await fetch("/api/account/cli-token", {
      method: "POST",
      headers: { accept: "application/json", authorization: `Bearer ${session.data.session.access_token}` },
    })
    const payload = await readAccountApiResponse(response, "Vector could not create a CLI token.")
    if (typeof payload.token !== "string") throw new Error("Vector could not create a CLI token.")
    setToken(payload.token)
    setCopied(false)
  }

  const fail = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : "Vector could not create a CLI token.")

  useEffect(() => {
    void mint()
      .catch(fail)
      .finally(() => setLoading(false))
  }, [])

  const copy = () => {
    if (!token) return
    void navigator.clipboard.writeText(token).then(() => setCopied(true))
  }

  if (loading) {
    return (
      <main className="account-loading">
        <LoaderCircle size={28} />
        <p>Preparing your CLI token…</p>
      </main>
    )
  }

  return (
    <main className="cli-pair-page">
      <div className="cli-pair-card">
        <span className="panel-icon">
          <TerminalSquare size={20} />
        </span>
        <p className="account-kicker">Vector CLI</p>
        <h1>Connect your terminal.</h1>
        <p className="cli-pair-copy">
          {email ? (
            <>
              Signed in as <strong>{email}</strong>.{" "}
            </>
          ) : null}
          Paste this token into the <code>vector login</code> prompt. It links the CLI to your free Vector account and
          expires in 90 days.
        </p>

        {error && <p className="account-error">{error}</p>}

        {token && (
          <div className="cli-pair-token">
            <code>{token}</code>
          </div>
        )}
        <div className="cli-pair-actions">
          {token && (
            <button type="button" className="cli-pair-copy-button" onClick={copy}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? "Copied" : "Copy token"}
            </button>
          )}
          <button type="button" className="cli-pair-refresh" onClick={() => void mint().catch(fail)}>
            <RefreshCw size={14} /> {token ? "New token" : "Try again"}
          </button>
        </div>

        <ol className="cli-pair-steps">
          <li>
            <code>vector</code> — start the agent in any repository
          </li>
          <li>Paste the token when prompted (or run <code>vector login</code>)</li>
          <li>
            That's it. Big Pickle is included free; add your own keys with <code>vector auth login</code>
          </li>
        </ol>
      </div>
    </main>
  )
}
