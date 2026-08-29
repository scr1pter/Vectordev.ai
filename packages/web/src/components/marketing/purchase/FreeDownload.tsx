/** @jsxImportSource react */
import { useEffect, useState } from "react"
import { Apple, Download, Monitor, Terminal } from "lucide-react"
import { DOWNLOAD_TARGETS, selectedDownloadTarget } from "./download-target"

// The download button. No licence, no email, no account — the installer is
// public and licensing is enforced inside the app on launch instead.
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

export function FreeDownload({ version }: { version?: string }) {
  const [target, setTarget] = useState(DOWNLOAD_TARGETS[0])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setTarget(selectedDownloadTarget(location.search, navigator.userAgent))
    setReady(true)
  }, [])

  return (
    <section className="free-download" aria-label="Download Vector">
      <a className="free-download-cta" href={`/api/download?target=${target.id}`} data-action="download-primary">
        <Download size={18} />
        <span>
          <strong>Download Vector</strong>
          {/* Rendered only after detection so the label never claims the wrong
              platform on the server-rendered first paint. */}
          <small>{ready ? `${target.os} · ${target.note}` : "Detecting your platform…"}</small>
        </span>
      </a>

      <p className="free-download-note">
        Free to download. No account, no email.{" "}
        {version ? `Checksum-verified release v${version}.` : "macOS, Windows and Linux."}
      </p>

      <details className="free-download-more">
        <summary>Other platforms</summary>
        <div className="free-download-grid">
          {DOWNLOAD_TARGETS.map((entry) => (
            <a
              key={entry.id}
              className={`free-download-alt ${entry.id === target.id ? "is-current" : ""}`}
              href={`/api/download?target=${entry.id}`}
            >
              <Glyph os={entry.os} />
              <span>
                <strong>{entry.os}</strong>
                <small>{entry.note}</small>
              </span>
            </a>
          ))}
        </div>
      </details>
    </section>
  )
}
