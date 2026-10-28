import { Option, Schema } from "effect"
import { codiumKey } from "./codium-keys.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

/*
 * Runtime switches (contract §4.16): the owner turns a Codium service off without a redeploy. Env variables say a
 * service is configured; a switch turns it off. WP A07 starts this module with the one read the renewal guard needs
 * (M7: no early renewal charge while `codium` is off). WP A11 adds the 30 s in-memory cache, the audit log, the owner
 * endpoint, `models-off` and `perks-off`, and may change how a value is stored; `readSwitch` reads both the bare value
 * and a JSON record with a `value` field.
 */

export const SWITCH_NAMES = ["sales", "codium", "cloudAgents", "hosted", "ops", "remote", "vault", "push"] as const
export type SwitchName = (typeof SWITCH_NAMES)[number]
/** `hosted` alone also takes `no-new` (no new work) and `stop` (running work stops too). */
export type SwitchValue = "on" | "off" | "no-new" | "stop"

const VALUES: Record<SwitchName, readonly SwitchValue[]> = {
  sales: ["on", "off"],
  codium: ["on", "off"],
  cloudAgents: ["on", "off"],
  hosted: ["on", "no-new", "stop"],
  ops: ["on", "off"],
  remote: ["on", "off"],
  vault: ["on", "off"],
  push: ["on", "off"],
}

/** `switch:<name>` under the mode prefix (§4.6). */
export const switchKey = (name: SwitchName) => codiumKey("switch", name)

const Stored = Schema.Struct({ value: Schema.String })

/**
 * A switch's value now. A switch nobody set is on. A value that cannot be read fails closed (503), so the caller retries
 * rather than acting as though the owner had left the service on.
 */
export async function readSwitch(name: SwitchName, fetcher: typeof fetch = fetch): Promise<SwitchValue> {
  const stored = await persistentStore(["GET", switchKey(name)], fetcher)
  if (stored === null || stored === undefined) return "on"
  const raw = String(stored)
  const value =
    Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Stored))(raw))?.value ?? raw.trim()
  const known = VALUES[name].find((allowed) => allowed === value)
  if (!known) throw new ApiError(503, "CODIUM_SWITCH_UNAVAILABLE", "A Vector Codium setting could not be read.")
  return known
}
