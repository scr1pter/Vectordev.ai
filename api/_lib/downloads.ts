import { ApiError } from "./http.js"

// Public installer downloads. Deliberately separate from api/billing/download,
// which serves the SAME files to a licensed customer and counts the download
// against their allowance. This path has no token, no customer and no Stripe
// call — anyone can fetch an installer, and licensing is enforced inside the
// app on launch instead of at the door.
//
// Stripe is not merely unused here, it is the point: the licensed endpoint
// calls stripeClient(), so while STRIPE_SECRET_KEY is unset every download 503s
// even though the installers are sitting in the blob store, reachable and
// signed. Public downloads must not inherit that failure.

export const PUBLIC_DOWNLOAD_TARGETS: Record<string, string> = {
  "mac-arm64": "vector-desktop-mac-arm64.dmg",
  "mac-x64": "vector-desktop-mac-x64.dmg",
  "windows-x64": "vector-desktop-win-x64.exe",
  "windows-arm64": "vector-desktop-win-arm64.exe",
  "linux-x64": "vector-desktop-linux-x86_64.AppImage",
  "linux-arm64": "vector-desktop-linux-arm64.AppImage",
}

export type DownloadPlatform = { target: string; label: string; note: string }

export const DOWNLOAD_MENU: DownloadPlatform[] = [
  { target: "mac-arm64", label: "macOS", note: "Apple silicon" },
  { target: "mac-x64", label: "macOS", note: "Intel" },
  { target: "windows-x64", label: "Windows", note: "x64" },
  { target: "windows-arm64", label: "Windows", note: "ARM" },
  { target: "linux-x64", label: "Linux", note: "AppImage x86_64" },
  { target: "linux-arm64", label: "Linux", note: "AppImage ARM64" },
]

export function installerFor(target: string | undefined) {
  const file = target ? PUBLIC_DOWNLOAD_TARGETS[target] : undefined
  if (!file) {
    throw new ApiError(404, "DOWNLOAD_NOT_FOUND", "That Vector installer does not exist.")
  }
  return file
}

// Which build to offer first. Architecture matters more than prettiness here:
// handing an Intel dmg to an Apple-silicon Mac still runs under Rosetta, but
// handing an arm64 AppImage to an x86 box does not run at all.
export function suggestedTarget(userAgent: string | undefined): string {
  const ua = (userAgent ?? "").toLowerCase()
  if (ua.includes("windows")) {
    // Windows on ARM reports an x86 token for compatibility; the only reliable
    // ARM signal in a browser UA is "arm64" appearing explicitly.
    return ua.includes("arm64") || ua.includes("aarch64") ? "windows-arm64" : "windows-x64"
  }
  if (ua.includes("mac os") || ua.includes("macintosh")) {
    // Safari and Chrome on Apple silicon still report "Intel Mac OS X", so the
    // UA alone cannot tell them apart. Apple silicon is the safe default in
    // 2026: an Intel Mac given the arm64 build fails loudly and obviously,
    // whereas Apple silicon given the Intel build silently runs slower forever.
    return "mac-arm64"
  }
  if (ua.includes("linux") || ua.includes("x11")) {
    return ua.includes("aarch64") || ua.includes("arm64") ? "linux-arm64" : "linux-x64"
  }
  return "mac-arm64"
}

export function contentTypeFor(file: string) {
  if (file.endsWith(".dmg")) return "application/x-apple-diskimage"
  if (file.endsWith(".exe")) return "application/vnd.microsoft.portable-executable"
  if (file.endsWith(".AppImage")) return "application/x-executable"
  return "application/octet-stream"
}
