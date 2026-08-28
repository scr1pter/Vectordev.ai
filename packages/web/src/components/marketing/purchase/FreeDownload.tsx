/** @jsxImportSource react */
import { useEffect, useState } from "react"
import { Apple, Download, Monitor, Terminal } from "lucide-react"

// The download button. No licence, no email, no account — the installer is
// public and licensing is enforced inside the app on launch instead.
//
// The architecture is chosen in the browser rather than on the server so the
// button can name the build before it is clicked ("macOS · Apple silicon"),
// and so a CDN-cached page never hands everyone whichever platform warmed the
// cache first.

type Target = { id: string; os: string; note: string }

const TARGETS: Target[] = [
  { id: "mac-arm64", os: "macOS", note: "Apple silicon" },
  { id: "mac-x64", os: "macOS", note: "Intel" },
  { id: "windows-x64", os: "Windows", note: "x64" },
  { id: "windows-arm64", os: "Windows", note: "ARM" },
  { id: "linux-x64", os: "Linux", note: "AppImage · x86_64" },
  { id: "linux-arm64", os: "Linux", note: "AppImage · ARM64" },
]

function detect(): string {
  if (typeof navigator === "undefined") return "mac-arm64"
  const ua = navigator.userAgent.toLowerCase()
  const arm = /arm64|aarch64/.test(ua)
  if (ua.includes("windows")) return arm ? "windows-arm64" : "windows-x64"
  if (ua.includes("linux") || ua.includes("x11")) return arm ? "linux-arm64" : "linux-x64"
  // Apple silicon Macs still report "Intel Mac OS X", so the user agent cannot
  // tell them apart. Defaulting to Intel would silently run under Rosetta on
  // most modern Macs; the Intel build stays one click away below.
  return "mac-arm64"
}

function Glyph({ os }: { os: string }) {
  if (os === "macOS") return <Apple size={17} />
  if (os === "Windows") return <Monitor size={17} />
  return <Terminal size={17} />
}

export function FreeDownload() {
  const [target, setTarget] = useState<Target>(TARGETS[0])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const id = detect()
    setTarget(TARGETS.find((entry) => entry.id === id) ?? TARGETS[0])
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

      <p className="free-download-note">Free to download. No account, no email. macOS, Windows and Linux.</p>

      <details className="free-download-more">
        <summary>Other platforms</summary>
        <div className="free-download-grid">
          {TARGETS.map((entry) => (
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
