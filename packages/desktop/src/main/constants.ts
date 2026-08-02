import { app } from "electron"
import { updaterEnabled } from "./updater-policy"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const UPDATER_ENABLED = updaterEnabled({
  packaged: app.isPackaged,
  channel: CHANNEL,
  override: process.env.VECTOR_ENABLE_AUTO_UPDATE,
})
