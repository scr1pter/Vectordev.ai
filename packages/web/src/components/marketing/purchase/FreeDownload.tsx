/** @jsxImportSource react */
import { useEffect, useState } from "react"
import { Apple, Download, Monitor, Terminal } from "lucide-react"
import { DOWNLOAD_TARGETS, selectedDownloadTarget } from "./download-target"

// Account clients resolve the installer through the authenticated download
// endpoint, then navigate to the large checksum-verified release asset.
//
// The architecture is chosen in the browser rather than on the server so the
// button can name the build before it is clicked ("macOS · Apple silicon"),
// and so a CDN-cached page never hands everyone whichever platform warmed the
// cache first.

function Glyph({ os }: { os: string }) {
  if (os === "macOS") return <Apple size={17} />
  if (os === "Windows") return <Monitor size={17} />
  return <Terminal size={17} />
}

export function FreeDownload({
  version,
  accessToken,
  accessAllowed = true,
}: {
  version?: string
  accessToken?: string
  accessAllowed?: boolean
}) {
  const [target, setTarget] = useState(DOWNLOAD_TARGETS[0])
  const [ready, setReady] = useState(false)
  const [downloading, setDownloading] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    setTarget(selectedDownloadTarget(location.search, navigator.userAgent))
    setReady(true)
  }, [])

  const download = (id: string) => {
    if (!accessToken) {
      location.assign(`/login?returnTo=${encodeURIComponent(`/account?target=${id}`)}`)
      return
    }
    if (!accessAllowed) {
      setError("An active Vector license is required to download this build.")
      return
    }
    setDownloading(id)
    setError("")
    void fetch(`/api/download?target=${encodeURIComponent(id)}`, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    })
      .then(async (response) => {
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
        const payload: unknown = contentType.includes("json") ? await response.json().catch(() => undefined) : undefined
        if (!payload || typeof payload !== "object" || !("url" in payload) || typeof payload.url !== "string") {
          const detail = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined
          const message = detail && typeof detail === "object" && "message" in detail ? detail.message : undefined
          throw new Error(
            typeof message === "string" && message.trim() ? message : "Vector could not prepare that installer.",
          )
        }
        if (!response.ok) throw new Error("Vector could not prepare that installer.")
        location.assign(payload.url)
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Vector could not prepare that installer.")
        setDownloading("")
      })
  }

  return (
    <section className="free-download" aria-label="Download Vector">
      <button
        className="free-download-cta"
        type="button"
        onClick={() => download(target.id)}
        disabled={Boolean(downloading) || !accessAllowed}
        data-action="download-primary"
      >
        <Download size={18} />
        <span>
          <strong>
            {!accessAllowed
              ? "License required"
              : downloading === target.id
                ? "Preparing installer…"
                : "Download Vector"}
          </strong>
          {/* Rendered only after detection so the label never claims the wrong
              platform on the server-rendered first paint. */}
          <small>{ready ? `${target.os} · ${target.note}` : "Detecting your platform…"}</small>
        </span>
      </button>

      <p className="free-download-note">
        Included with your Vector account during private beta.{" "}
        {version ? `Checksum-verified release v${version}.` : "macOS, Windows and Linux."}
      </p>
      {error && <p className="purchase-error">{error}</p>}

      <details className="free-download-more">
        <summary>Other platforms</summary>
        <div className="free-download-grid">
          {DOWNLOAD_TARGETS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`free-download-alt ${entry.id === target.id ? "is-current" : ""}`}
              onClick={() => download(entry.id)}
              disabled={Boolean(downloading) || !accessAllowed}
            >
              <Glyph os={entry.os} />
              <span>
                <strong>{entry.os}</strong>
                <small>{entry.note}</small>
              </span>
            </button>
          ))}
        </div>
      </details>
    </section>
  )
}
