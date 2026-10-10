export * as ProviderRemotePolicy from "./provider-remote-policy"

import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { Option, Schema } from "effect"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { applyRemoteProviderPolicy } from "./provider-policy"

// The owner's off-switch for Sign in with ChatGPT, published with the website so it can change without a
// release. docs/vector/owner-actions/chatgpt.md says how to flip it.
export const POLICY_URL = "https://vectordev.ai/policy/providers.json"
// Startup checks reuse a read from the last few minutes; a sign-in rereads unless the server just did.
const TTL = 5 * 60_000
const FRESH = 10_000

// Fields older builds do not know are ignored, so the website can add switches before they ship.
const Policy = Schema.Struct({ chatgptSignIn: Schema.Boolean })
export type Policy = typeof Policy.Type

export function createClient(input: {
  file: string
  apply: (policy: Policy) => void
  request?: (url: string, init: RequestInit) => Promise<Response>
  disabled?: () => boolean
  now?: () => number
  /** How long a check waits for vectordev.ai before keeping the last value seen. */
  wait?: number
}) {
  const request = input.request ?? fetch
  const now = input.now ?? Date.now
  const state: { restored?: Promise<void>; pending?: Promise<void>; checked: number } = { checked: 0 }

  // The last answer survives restarts, so a website that cannot be reached keeps the owner's last decision.
  const restore = () => {
    if (input.disabled?.()) return Promise.resolve()
    state.restored ??= readFile(input.file, "utf8")
      .then((text) => {
        const saved = Schema.decodeUnknownOption(Schema.fromJsonString(Policy))(text)
        if (Option.isSome(saved)) input.apply(saved.value)
      })
      .catch(() => undefined)
    return state.restored
  }

  /** Reads the switch from vectordev.ai and never fails; `force` is for a sign-in about to start. */
  const check = (force = false) => {
    if (state.pending) return state.pending
    if (now() - state.checked < (force ? FRESH : TTL)) return restore()
    const pending = (async () => {
      if (input.disabled?.()) return
      await restore()
      const response = await request(POLICY_URL, {
        redirect: "error",
        signal: AbortSignal.timeout(input.wait ?? 3_000),
        headers: { accept: "application/json" },
      }).catch(() => undefined)
      const policy = response?.ok
        ? Option.getOrUndefined(Schema.decodeUnknownOption(Policy)(await response.json().catch(() => undefined)))
        : undefined
      // An unanswered read counts too, so an offline sign-in waits for the website once, not twice.
      state.checked = now()
      if (!policy) return
      input.apply(policy)
      const temporary = `${input.file}.${randomUUID()}.tmp`
      // The cache is optional: failing to write it must not fail startup or a sign-in.
      await mkdir(path.dirname(input.file), { recursive: true })
        .then(() => writeFile(temporary, JSON.stringify(policy), { mode: 0o600 }))
        .then(() => rename(temporary, input.file))
        .catch(() => rm(temporary, { force: true }).catch(() => undefined))
    })().finally(() => {
      state.pending = undefined
    })
    state.pending = pending
    return pending
  }

  return { restore, check }
}

const client = createClient({
  file: path.join(Global.Path.cache, "provider-policy.json"),
  apply: applyRemoteProviderPolicy,
  // Operators who turn off Vector's metadata fetches follow the release default.
  disabled: () => Flag.VECTOR_DISABLE_MODELS_FETCH,
})

export const restore = client.restore
export const check = client.check
