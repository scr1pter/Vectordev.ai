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

export const DOWNLOAD_MANIFEST_PATH = "releases/vector-downloads/latest.json"

export type DownloadManifestTarget = {
  filename: string
  pathname: string
  url: string
  size: number
  sha256: string
  verification: "release-workflow"
}

export type DownloadManifest = {
  schemaVersion: 1
  version: string
  channel: "latest"
  publishedAt: string
  targets: Record<string, DownloadManifestTarget>
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

export function parseDownloadManifest(input: unknown, expectedOrigin?: string): DownloadManifest {
  if (!isRecord(input)) throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", "Vector's release manifest is invalid.")
  if (input.schemaVersion !== 1 || input.channel !== "latest") {
    throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", "Vector's release manifest is invalid.")
  }
  if (typeof input.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) {
    throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", "Vector's release manifest has an invalid version.")
  }
  const version = input.version
  if (typeof input.publishedAt !== "string" || !Number.isFinite(Date.parse(input.publishedAt))) {
    throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", "Vector's release manifest has an invalid date.")
  }
  if (!isRecord(input.targets)) {
    throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", "Vector's release manifest has no installers.")
  }
  const inputTargets = input.targets

  const expectedTargets = Object.keys(PUBLIC_DOWNLOAD_TARGETS).sort()
  if (Object.keys(inputTargets).sort().join("\n") !== expectedTargets.join("\n")) {
    throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", "Vector's release manifest is incomplete.")
  }

  let releaseOrigin = expectedOrigin
  const targets = Object.fromEntries(
    expectedTargets.map((target) => {
      const entry = inputTargets[target]
      const filename = PUBLIC_DOWNLOAD_TARGETS[target]
      if (!filename) {
        throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", `Vector's ${target} installer is unknown.`)
      }
      const pathname = `releases/vector-v${version}/${filename}`
      if (!isRecord(entry) || entry.filename !== filename || entry.pathname !== pathname) {
        throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", `Vector's ${target} installer entry is invalid.`)
      }
      if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
        throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", `Vector's ${target} installer size is invalid.`)
      }
      if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", `Vector's ${target} installer checksum is invalid.`)
      }
      if (entry.verification !== "release-workflow" || typeof entry.url !== "string") {
        throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", `Vector's ${target} installer verification is invalid.`)
      }
      const url = safeUrl(entry.url)
      if (
        !url ||
        url.protocol !== "https:" ||
        !url.hostname.endsWith(".public.blob.vercel-storage.com") ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        url.pathname.replace(/^\//, "") !== pathname
      ) {
        throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", `Vector's ${target} installer URL is invalid.`)
      }
      if (releaseOrigin && url.origin !== releaseOrigin) {
        throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", "Vector's release manifest mixes storage origins.")
      }
      releaseOrigin = url.origin
      return [
        target,
        {
          filename,
          pathname,
          url: entry.url,
          size: entry.size,
          sha256: entry.sha256,
          verification: "release-workflow" as const,
        },
      ]
    }),
  )

  return {
    schemaVersion: 1,
    version,
    channel: "latest",
    publishedAt: input.publishedAt,
    targets,
  }
}

export function parseDownloadManifestJson(input: string, expectedOrigin?: string) {
  try {
    return parseDownloadManifest(JSON.parse(input) as unknown, expectedOrigin)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", "Vector's release manifest is not valid JSON.")
  }
}

export function installerFromManifest(manifest: DownloadManifest, target: string | undefined) {
  installerFor(target)
  const entry = target ? manifest.targets[target] : undefined
  if (!entry) throw new ApiError(404, "DOWNLOAD_NOT_FOUND", "That Vector installer is not available yet.")
  return entry
}

export function checksumsFromManifest(manifest: DownloadManifest) {
  const first = manifest.targets[Object.keys(PUBLIC_DOWNLOAD_TARGETS)[0]!]
  if (!first) throw new ApiError(503, "DOWNLOAD_MANIFEST_INVALID", "Vector's release manifest is incomplete.")
  const url = new URL(first.url)
  url.pathname = `/releases/vector-v${manifest.version}/checksums.txt`
  url.search = ""
  url.hash = ""
  return url.toString()
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function safeUrl(input: string) {
  try {
    return new URL(input)
  } catch {
    return undefined
  }
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
