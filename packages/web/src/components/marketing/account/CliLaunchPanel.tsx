/** @jsxImportSource react */
import { Check, Copy } from "lucide-react"
import { useEffect, useState } from "react"
import { readAccountApiResponse } from "../../../lib/account-client"

/**
 * Account-page section: launch the desktop app (vector:// deep link) or pair
 * the CLI. The pairing command is minted from the signed-in session, so there
 * is no second login and no password.
 */
export function CliLaunchPanel(props: { accessToken: string }) {
  const [token, setToken] = useState("")
  const [error, setError] = useState("")
  const [copied, setCopied] = useState<"install" | "login" | "">("")

  useEffect(() => {
    if (!props.accessToken) return
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
  }, [props.accessToken])

  const install = "npm install -g @vectordevai/cli"
  const login = token ? `vector login --token ${token}` : ""
  const copy = (which: "install" | "login", text: string) => {
    void navigator.clipboard.writeText(text).then(() => setCopied(which))
  }

  return (
    <section className="acct-section">
      <h2>Vector CLI</h2>
      <p>The same agent in your terminal. Two commands, then type <code>vector</code> inside any repository.</p>

      <ol className="acct-steps">
        <li>
          <span>Install once</span>
          <div className="acct-code-row">
            <code>{install}</code>
            <button type="button" onClick={() => copy("install", install)}>
              {copied === "install" ? <Check size={14} /> : <Copy size={14} />}
              {copied === "install" ? "Copied" : "Copy"}
            </button>
          </div>
        </li>
        <li>
          <span>Sign the CLI in — this command is already tied to your account</span>
          {login ? (
            <div className="acct-code-row">
              <code>{login}</code>
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

      <a className="acct-button acct-button-secondary" href="vector://open">
        Open Vector on this computer
      </a>
      <p className="acct-fine">Free model included. Add your own keys any time with <code>vector auth login</code>.</p>
    </section>
  )
}
