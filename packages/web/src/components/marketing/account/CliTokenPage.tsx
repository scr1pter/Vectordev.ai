/** @jsxImportSource react */
import { Check, Copy, LoaderCircle, RefreshCw, TerminalSquare } from "lucide-react"
import { useEffect, useState } from "react"
import { readAccountApiResponse, vectorAccountClient } from "../../../lib/account-client"
import { deletionConfirmation, desktopSignInCallback, desktopSignInRequest } from "../../../lib/desktop-sign-in"
import "./account.css"

/**
 * /auth/cli — pairs the Vector CLI with a Vector account. Signed-in users get
 * a vct_ token to paste into `vector login`; everyone else bounces to /login.
 * With purpose=delete, the desktop app is confirming that the person deleting
 * the account is signed in here: nothing happens until they choose Continue,
 * so a link alone cannot sign anyone out or send a confirmation, and a sign-in
 * older than a few minutes has to be made again.
 */
export function CliTokenPage() {
  const [token, setToken] = useState("")
  const [email, setEmail] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [callback, setCallback] = useState("")
  // Deleting waits for the person to choose Continue on this page.
  const [confirm, setConfirm] = useState(false)
  const query = typeof location !== "undefined" ? new URLSearchParams(location.search) : undefined
  const desktop = query?.get("desktop") === "1"
  const deleting = desktop && query?.get("purpose") === "delete"

  // Always read the live session: Supabase rotates access tokens, so a token
  // captured at mount goes stale and would 401 on "New token".
  const mint = async (confirmed = false) => {
    setError("")
    const desktopRequest = desktopSignInRequest(location.search)
    const client = await vectorAccountClient()
    const session = await client.auth.getSession()
    if (session.error) throw session.error
    if (!session.data.session) {
      location.replace(`/login?returnTo=${encodeURIComponent(desktopRequest?.returnPath ?? "/auth/cli")}`)
      return
    }
    const deletion =
      desktopRequest?.purpose === "delete"
        ? deletionConfirmation(confirmed, session.data.session.access_token)
        : undefined
    if (deletion === "ask") {
      setEmail(session.data.session.user.email ?? "")
      setConfirm(true)
      return
    }
    if (desktopRequest && deletion === "sign-in-again") {
      // Only this browser's session is signed out; the person signs in again and comes straight back here.
      await client.auth.signOut({ scope: "local" })
      location.replace(`/login?${new URLSearchParams({ returnTo: desktopRequest.returnPath, reauth: "1" })}`)
      return
    }
    setEmail(session.data.session.user.email ?? "")
    if (desktopRequest) {
      const response = await fetch("/api/account/cli-code", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${session.data.session.access_token}`,
        },
        body: JSON.stringify({
          state: desktopRequest.state,
          challenge: desktopRequest.challenge,
          ...(desktopRequest.purpose ? { purpose: desktopRequest.purpose } : {}),
        }),
      })
      const payload = await readAccountApiResponse(response, "Vector could not connect this desktop.")
      const link = desktopSignInCallback(payload, desktopRequest.state)
      setCallback(link)
      location.assign(link)
      return
    }
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

  // Hand out a complete command: pasting a bare token into a shell runs it
  // as a program ("command not found: vct_…"), a full command just works.
  const command = token ? `vector login --token ${token}` : ""

  const copy = () => {
    if (!command) return
    void navigator.clipboard.writeText(command).then(() => setCopied(true))
  }

  if (loading) {
    return (
      <main className="account-loading">
        <LoaderCircle size={28} />
        <p>{deleting ? "Confirming it is you…" : desktop ? "Connecting your desktop…" : "Preparing your CLI token…"}</p>
      </main>
    )
  }

  return (
    <main className="cli-pair-page">
      <div className="cli-pair-card">
        <span className="panel-icon">
          <TerminalSquare size={20} />
        </span>
        <p className="account-kicker">{desktop ? "Vector desktop" : "Vector CLI"}</p>
        <h1>
          {confirm
            ? "Delete your Vector account?"
            : deleting
              ? "Confirm in Vector."
              : desktop
                ? "Continue in Vector."
                : "Connect your terminal."}
        </h1>
        <p className="cli-pair-copy">
          {email ? (
            <>
              Signed in as <strong>{email}</strong>.{" "}
            </>
          ) : null}
          {confirm
            ? "Vector asked to confirm that you want to delete this account. Continue to confirm it is you, then choose Delete my account in Vector to finish. If you did not start this, close this page."
            : deleting
              ? "Open Vector to finish deleting your account there. This link works once and expires in five minutes."
              : desktop
                ? "Open Vector to finish signing in. This link works once and expires in five minutes."
                : "Run this command in your terminal. It links the Vector CLI to your free account and expires in 90 days."}
        </p>

        {error && <p className="account-error">{error}</p>}

        {command && (
          <div className="cli-pair-token">
            <code>
              <span className="cli-pair-prompt" aria-hidden="true">
                ${" "}
              </span>
              {command}
            </code>
          </div>
        )}
        <div className="cli-pair-actions">
          {confirm && (
            <button
              type="button"
              className="cli-pair-copy-button"
              onClick={() => {
                setConfirm(false)
                setLoading(true)
                void mint(true)
                  .catch(fail)
                  .finally(() => setLoading(false))
              }}
            >
              Continue
            </button>
          )}
          {callback && (
            <a className="cli-pair-copy-button" href={callback}>
              Open Vector
            </a>
          )}
          {token && (
            <button type="button" className="cli-pair-copy-button" onClick={copy}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? "Copied" : "Copy command"}
            </button>
          )}
          {!confirm && (
            <button type="button" className="cli-pair-refresh" onClick={() => void mint(deleting).catch(fail)}>
              <RefreshCw size={14} /> {token ? "New token" : "Try again"}
            </button>
          )}
        </div>

        {!desktop && (
          <ol className="cli-pair-steps">
            <li>
              Install once: <code>npm install -g @vectordevai/cli</code>
            </li>
            <li>Run the command above — it signs the CLI in</li>
            <li>
              <code>vector</code> — start the agent in any repository
            </li>
            <li>
              Connect your own provider with <code>vector auth login</code>. From 1.99.99, connecting your own
              OpenRouter account adds its zero-price models under Models included with Vector
            </li>
          </ol>
        )}
      </div>
    </main>
  )
}
