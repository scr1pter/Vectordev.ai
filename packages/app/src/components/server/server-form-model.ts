import { normalizeServerUrl } from "@/context/server"

/** The username Vector's desktop engine is started with (the sidecar sets OPENCODE_SERVER_USERNAME to it). A plain
 *  CLI engine defaults to CLI_SERVER_USERNAME. Add mode only sends it once a password is set, so the prefill is inert
 *  until then. */
export const DEFAULT_SERVER_USERNAME = "vector"

/** The username a plain `opencode serve` engine uses. */
export const CLI_SERVER_USERNAME = "opencode"

/** How long typing has to pause before the live reachability check runs. */
export const SERVER_PREVIEW_DELAY_MS = 350

/** Copy the redesign added. It is not in the i18n dictionaries yet (en.ts was locked by another change when this
 *  shipped), so it renders for English only; other locales leave these lines out or fall back to strings they already
 *  translate, instead of mixing English into a localized dialog. The key each string should move to is noted. */
export const SERVER_FORM_COPY = {
  addDescription: "Connect Vector to an engine on another machine or port.", // dialog.server.add.description
  editDescription: "Update this engine's address, name or credentials.", // dialog.server.edit.description
  addressHelper: "The address of a running Vector engine, including its port.", // dialog.server.add.helper
  reachable: "Server is reachable", // dialog.server.add.reachable
  required: "Enter a server address to continue", // dialog.server.add.required
  auth: "Authentication", // dialog.server.add.auth
  authNone: "No password", // dialog.server.add.authNone
  authPasswordSet: "Password set", // dialog.server.add.authPasswordSet
  showPassword: "Show password", // dialog.server.add.showPassword
  // dialog.server.add.authHint: {{desktop}} and {{cli}} are the two default usernames, rendered as code.
  authHint:
    "Only needed if the engine was started with a password. Desktop engines use the username {{desktop}}, CLI engines {{cli}}.",
} as const

export type ServerFormCopy = typeof SERVER_FORM_COPY

/** The redesign's copy for a locale, or undefined where it has no translation yet. */
export function serverFormCopy(locale: string): ServerFormCopy | undefined {
  return locale === "en" ? SERVER_FORM_COPY : undefined
}

/** True once a typed address is specific enough to be worth a live health check. */
export function looksLikeServerAddress(value: string) {
  const normalized = normalizeServerUrl(value)
  if (!normalized) return false
  const host = normalized.replace(/^https?:\/\//, "").split("/")[0]
  if (!host) return false
  // A scheme still being typed ("http://" normalizes to "http:") or a port with no host is not a host yet. A dangling
  // port colon is fine: "localhost:" is the same URL as "localhost", so the check keeps running while a port is typed.
  if (/^https?:$/i.test(host) || host.startsWith(":")) return false
  if (host.includes("localhost") || host.startsWith("127.0.0.1")) return true
  return host.includes(".") || host.includes(":")
}

export type ServerFormStatus = "idle" | "required" | "checking" | "reachable" | "unreachable" | "error"

export type ServerFormStatusInput = {
  value: string
  /** Message left by a failed save. */
  error: string
  /** A live preview check is scheduled or in flight. */
  checking: boolean
  /** Result of the latest live preview check. */
  status: boolean | undefined
  /** A submit was refused because the address is empty. */
  required?: boolean
}

/** The one line under the address: a failed save wins, then a refused empty submit, then any running live check, then
 *  the last preview result. A running save does not show here; the primary button carries its progress. */
export function serverFormStatus(input: ServerFormStatusInput): ServerFormStatus {
  if (input.error) return "error"
  if (input.required && !normalizeServerUrl(input.value)) return "required"
  if (!looksLikeServerAddress(input.value)) return "idle"
  if (input.checking) return "checking"
  if (input.status === true) return "reachable"
  if (input.status === false) return "unreachable"
  return "idle"
}

/** Statuses worth announcing to a screen reader: settled results, not the helper or a check still running. */
export function announcesServerStatus(status: ServerFormStatus) {
  return status === "reachable" || status === "unreachable" || status === "error" || status === "required"
}

export type ServerFormSubmitState = { disabled: false } | { disabled: true; reason: "empty" | "busy" }

/** Saving needs an address and no save already running. A live preview may still be in flight: the save runs its
 *  own check (and reuses an identical in-flight one), so it does not wait for the preview. */
export function serverFormSubmitState(input: { value: string; busy: boolean }): ServerFormSubmitState {
  if (input.busy) return { disabled: true, reason: "busy" }
  if (!normalizeServerUrl(input.value)) return { disabled: true, reason: "empty" }
  return { disabled: false }
}

/** Authentication starts collapsed unless there is something in it worth seeing: any stored credential when
 *  editing, or a password / non-default username when adding. */
export function authenticationStartsOpen(input: { mode: "add" | "edit"; username: string; password: string }) {
  if (input.password) return true
  if (!input.username) return false
  if (input.mode === "edit") return true
  return input.username !== DEFAULT_SERVER_USERNAME
}

/** What the collapsed Authentication row says: whether a password is set, and for which username. The username is
 *  kept apart so a long one can be cut short without losing the password state. */
export function authenticationSummary(input: { username: string; password: string }): {
  username?: string
  password: boolean
} {
  if (!input.password) return { password: false }
  if (!input.username) return { password: true }
  return { username: input.username, password: true }
}

/** Splits a trailing parenthetical off a label: "Username (optional)" gives "Username" and "optional". Handles
 *  full-width brackets too, so every locale's "(optional)" can be shown once, muted, instead of on each label. */
export function splitOptionalLabel(label: string): { text: string; hint?: string } {
  const match = /^(.*\S)\s*[(（]\s*([^()（）]*\S)\s*[)）]\s*$/u.exec(label)
  if (!match) return { text: label }
  return { text: match[1], hint: match[2] }
}

/** A blank name falls back to the address without its scheme (see serverName), so the placeholder previews that. */
export function serverNamePlaceholder(value: string, fallback: string) {
  const normalized = normalizeServerUrl(value)
  if (!normalized) return fallback
  return normalized.replace(/^https?:\/\//, "")
}

export type TemplatePart = { text: string } | { token: string }

/** Splits "a {{x}} b" into text and token parts, so a sentence can carry inline elements where its tokens sit. */
export function templateParts(template: string): TemplatePart[] {
  return template
    .split(/(\{\{\w+\}\})/)
    .filter((part) => part.length > 0)
    .map((part) => {
      const token = /^\{\{(\w+)\}\}$/.exec(part)?.[1]
      return token ? { token } : { text: part }
    })
}

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

/** Debounced, latest-wins runner for the live reachability check: a newer keystroke cancels a pending check, and a
 *  slower older result never overwrites a newer one. */
export function createPreviewScheduler(options: { delayMs: number; timers?: Timers }) {
  const timers: Timers = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
  }
  let seq = 0
  let timer: unknown

  const cancel = () => {
    seq++
    if (timer === undefined) return
    timers.clearTimeout(timer)
    timer = undefined
  }

  const schedule = <T>(run: () => Promise<T>, apply: (value: T) => void) => {
    cancel()
    const id = seq
    timer = timers.setTimeout(() => {
      timer = undefined
      void run().then(
        (value) => {
          if (id === seq) apply(value)
        },
        () => {},
      )
    }, options.delayMs)
  }

  return { schedule, cancel }
}
