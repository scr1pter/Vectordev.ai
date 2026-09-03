/** @jsxImportSource react */
import { Check, Copy, MonitorPlay, TerminalSquare } from "lucide-react"
import { useEffect, useState } from "react"
import { readAccountApiResponse } from "../../../lib/account-client"

/**
 * Account-page panel: launch the desktop app (vector:// deep link) or pair the
 * CLI. The pairing command is minted from the signed-in session, so there is
 * no second login and no password — the account is already proven.
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
    <article className="account-panel cli-launch-panel">
      <div className="panel-heading">
        <span className="panel-icon">
          <TerminalSquare size={18} />
        </span>
        <div>
          <p>Launch</p>
          <h2>Open Vector, or use the CLI</h2>
        </div>
      </div>
      <p className="panel-copy">You're signed in, so nothing here asks for a password.</p>

      <a className="cli-launch-desktop" href="vector://open">
        <MonitorPlay size={16} /> Launch Vector on this computer
      </a>

      <div className="cli-launch-step">
        <span>1. Install the CLI once</span>
        <code>{install}</code>
        <button type="button" onClick={() => copy("install", install)}>
          {copied === "install" ? <Check size={14} /> : <Copy size={14} />}
          {copied === "install" ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="cli-launch-step">
        <span>2. Sign the CLI in — run this in your terminal</span>
        {login ? (
          <>
            <code>{login}</code>
            <button type="button" onClick={() => copy("login", login)}>
              {copied === "login" ? <Check size={14} /> : <Copy size={14} />}
              {copied === "login" ? "Copied" : "Copy"}
            </button>
          </>
        ) : (
          <code className="cli-launch-pending">{error || "Preparing your sign-in command…"}</code>
        )}
      </div>

      <p className="cli-launch-note">
        3. Type <code>vector</code> in any repository. Free model included; add your own keys with{" "}
        <code>vector auth login</code>.
      </p>
    </article>
  )
}
