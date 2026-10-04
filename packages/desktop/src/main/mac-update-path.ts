import { resolve } from "node:path"

export function macAppBundlePath(executablePath: string) {
  const bundle = resolve(executablePath, "../../..")
  if (!bundle.endsWith(".app")) throw new Error("Vector is not running from a macOS application bundle")
  return bundle
}

// A mounted disk image is read-only, and macOS runs a quarantined app from a random read-only copy (App
// Translocation), so replacing either would fail or would not update the copy the user opens next time.
export function isReadOnlyMacLocation(bundle: string) {
  return bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")
}
