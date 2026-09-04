/** @jsxImportSource react */
import { Check, Copy, Eye, EyeOff } from "lucide-react"
import { useEffect, useState } from "react"
import { readAccountApiResponse } from "../../../lib/account-client"

/**
 * Account-page section: launch the desktop app (vector:// deep link) or pair
 * the CLI. The pairing command is minted from the signed-in session, so there
 * is no second login and no password. The token is a signed credential, so it
 * is masked by default — people copy it, they never need to read it.
 */
export function CliLaunchPanel(props: { accessToken: string; previewToken?: string }) {
  const [token, setToken] = useState(props.previewToken ?? "")
  const [error, setError] = useState("")
  const [copied, setCopied] = useState<"install" | "login" | "">("")
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    if (props.previewToken || !props.accessToken) return
    setError("")
    void fetch("/api/account/cli-token", {
      method: "POST",
      headers: { accept: "application/json", authorization: `Bearer ${props.accessToken}` },
    })
      .then(async (response) => {
        const payload = await readAccountApiResponse(response, "Vector could not prepare the CLI sign-in.")
        if (typeof payload.token === "string") setToken(payload.token)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Vector could not prepare the CLI sign-in."))
  }, [props.accessToken, props.previewToken])

  const install = "npm install -g @vectordevai/cli"
  const login = token ? `vector login --token ${token}` : ""
  const masked = token ? `vector login --token ${token.slice(0, 8)}••••••••${token.slice(-4)}` : ""
  const copy = (which: "install" | "login", text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(which)
      window.setTimeout(() => setCopied(""), 2200)
    })
  }

  return (
    <section className="acct-section">
      <h2>Vector CLI</h2>
      <p>
        The same agent in your terminal. Run these two commands once, then type <code>vector</code> inside any
        repository.
      </p>

      <ol className="acct-steps">
        <li>
          <span>Install</span>
          <div className="acct-code-row">
            <code>{install}</code>
            <button type="button" onClick={() => copy("install", install)}>
              {copied === "install" ? <Check size={14} /> : <Copy size={14} />}
              {copied === "install" ? "Copied" : "Copy"}
            </button>
          </div>
        </li>
        <li>
          <span>Sign in — this command is already tied to your account, so there's nothing to type</span>
          {login ? (
            <div className="acct-code-row">
              <code title={revealed ? undefined : "Your personal CLI token. Copy it; you don't need to read it."}>
                {revealed ? login : masked}
              </code>
              <button
                type="button"
                className="acct-icon-button"
                aria-label={revealed ? "Hide token" : "Show token"}
                onClick={() => setRevealed((value) => !value)}
              >
                {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button type="button" onClick={() => copy("login", login)}>
                {copied === "login" ? <Check size={14} /> : <Copy size={14} />}
                {copied === "login" ? "Copied" : "Copy"}
              </button>
            </div>
          ) : (
            <div className="acct-code-row acct-code-pending">
              <code>{error || "Preparing your sign-in command…"}</code>
            </div>
          )}
        </li>
      </ol>

      <div className="acct-actions">
        <a className="acct-button acct-button-secondary" href="vector://open">
          Open Vector on this computer
        </a>
      </div>
      <p className="acct-fine">
        The token is your personal CLI credential — it expires in 90 days, and you can generate a fresh one at any time
        from this page. Free model included; add your own keys with <code>vector auth login</code>.
      </p>
    </section>
  )
}
