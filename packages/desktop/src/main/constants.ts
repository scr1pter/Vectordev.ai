import { app } from "electron"
import { updaterPolicy } from "./updater-policy"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

const updater = updaterPolicy({
  packaged: app.isPackaged,
  channel: CHANNEL,
  override: process.env.VECTOR_ENABLE_AUTO_UPDATE,
})
export const UPDATER_ENABLED = updater.enabled
export const UPDATER_DISABLED_REASON = updater.enabled ? undefined : updater.reason
