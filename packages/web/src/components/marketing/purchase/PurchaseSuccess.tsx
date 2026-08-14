/** @jsxImportSource react */
import { CheckCircle2, Copy, Download, LoaderCircle } from "lucide-react"
import { useEffect, useState } from "react"
import "./purchase.css"

type Claim = {
  licenseKey: string
  downloadToken: string
  status: { email: string; expiresAt: string; plan: "monthly" | "annual" }
}

const targets = [
  ["mac-arm64", "macOS — Apple Silicon"],
  ["mac-x64", "macOS — Intel"],
  ["windows-x64", "Windows — x64"],
  ["windows-arm64", "Windows — ARM64"],
  ["linux-x64", "Linux — x64"],
  ["linux-arm64", "Linux — ARM64"],
] as const

export function PurchaseSuccess() {
  const [claim, setClaim] = useState<Claim>()
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const sessionId = new URLSearchParams(location.search).get("session_id")
    if (!sessionId) {
      setError("This purchase link is incomplete. Use the link in your Vector receipt email.")
      return
    }
    void fetch("/api/billing/claim", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sessionId }),
    })
      .then(async (response) => {
        const payload = await response.json()
        if (!response.ok) throw new Error(payload?.error?.message || "Vector could not verify this purchase.")
        setClaim(payload)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Vector could not verify this purchase."))
  }, [])

  const copyKey = async () => {
    const value = claim?.licenseKey
    if (!value) return
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const downloadUrl = (target: string) =>
    `/api/billing/download?token=${encodeURIComponent(claim?.downloadToken || "")}&target=${encodeURIComponent(target)}`

  return (
    <div className="purchase-page">
      <section className="license-shell">
        {!claim && !error && (
          <>
            <LoaderCircle size={28} className="spin" />
            <h1>Verifying your purchase…</h1>
            <p>Vector is preparing your license and protected installer.</p>
          </>
        )}
        {error && (
          <>
            <h1>We could not open this purchase.</h1>
            <p className="purchase-error">{error}</p>
            <p>
              <a href="/download">Return to downloads</a>
            </p>
          </>
        )}
        {claim && (
          <>
            <CheckCircle2 size={30} color="#75d7a7" />
            <h1>Your Vector license is ready.</h1>
            <p>
              A copy was sent to {claim.status.email}. Save the key, choose the installer for this computer, and
              activate Vector when the app opens.
            </p>
            <div className="license-key">
              <code>{claim.licenseKey}</code>
              <button type="button" onClick={copyKey}>
                <Copy size={14} /> {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="platform-list">
              {targets.map(([target, label]) => (
                <a key={target} href={downloadUrl(target)}>
                  <span>{label}</span>
                  <Download size={15} />
                </a>
              ))}
            </div>
            <p className="purchase-note">
              The protected installer link is for your initial download. The app can update itself after activation.
            </p>
          </>
        )}
      </section>
    </div>
  )
}
