import { homedir } from "node:os"
import { join } from "node:path"

// OPENCODE_CONFIG_DIR is the sidecar's authoritative Global.config path. XDG
// is only the fallback used when Vector runs outside the packaged desktop.
export function vectorConfigDir() {
  const explicit = process.env.OPENCODE_CONFIG_DIR?.trim()
  if (explicit) return explicit
  const root = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config")
  return join(root, process.env.VECTOR_APP_NAMESPACE ?? "vector")
}
