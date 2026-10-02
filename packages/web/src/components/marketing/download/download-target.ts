export type DownloadTarget = { id: string; os: string; note: string }

export const DOWNLOAD_TARGETS: DownloadTarget[] = [
  { id: "mac-arm64", os: "macOS", note: "Apple silicon" },
  { id: "mac-x64", os: "macOS", note: "Intel" },
  { id: "windows-x64", os: "Windows", note: "x64" },
  { id: "windows-arm64", os: "Windows", note: "ARM" },
  { id: "linux-x64", os: "Linux", note: "AppImage · x86_64" },
  { id: "linux-arm64", os: "Linux", note: "AppImage · ARM64" },
]

export function detectedDownloadTarget(userAgent: string | undefined) {
  const ua = (userAgent ?? "").toLowerCase()
  const arm = /arm64|aarch64/.test(ua)
  if (ua.includes("windows")) return arm ? "windows-arm64" : "windows-x64"
  if (ua.includes("linux") || ua.includes("x11")) return arm ? "linux-arm64" : "linux-x64"
  // Apple silicon Macs still report "Intel Mac OS X", so the user agent cannot
  // tell them apart. Defaulting to Intel would silently run under Rosetta on
  // most modern Macs; the Intel build stays one click away below.
  return "mac-arm64"
}

export function selectedDownloadTarget(search: string, userAgent: string | undefined) {
  const requested = new URLSearchParams(search).get("target")
  return (
    DOWNLOAD_TARGETS.find((entry) => entry.id === requested) ??
    DOWNLOAD_TARGETS.find((entry) => entry.id === detectedDownloadTarget(userAgent)) ??
    DOWNLOAD_TARGETS[0]
  )
}
