import { homedir } from "node:os"
import { join } from "node:path"

// VECTOR_AGENT_CONFIG_DIR is the sidecar's authoritative Global.config path. XDG
// is only the fallback used when Vector runs outside the packaged desktop.
export function vectorConfigDir() {
  const explicit = process.env.VECTOR_AGENT_CONFIG_DIR?.trim()
  if (explicit) return explicit
  const root = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config")
  return join(root, process.env.VECTOR_APP_NAMESPACE ?? "vector")
}

// The engine keeps its data in <XDG_DATA_HOME>/vector (Global.Path.data), which preferAppEnv points into userData for
// the desktop, so the main process and the sidecar agree on it.
export function vectorDataDir() {
  const root = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share")
  return join(root, process.env.VECTOR_APP_NAMESPACE ?? "vector")
}
