import { resolve } from "node:path"

export function macAppBundlePath(executablePath: string) {
  const bundle = resolve(executablePath, "../../..")
  if (!bundle.endsWith(".app")) throw new Error("Vector is not running from a macOS application bundle")
  return bundle
}
