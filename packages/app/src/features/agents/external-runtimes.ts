import { ExternalAgent } from "@vectordevai/schema/external-agent"

// The third-party coding agents Vector can run as a workspace engine in its own
// chat, derived from the one catalog in @vectordevai/schema/external-agent that
// desktop detection reads too. Installing and signing in to them, and every
// terminal-only agent, is Host locally's (dialog-host-locally.tsx).

/** A runtime Vector can run in its own chat view: the catalog's "chat" tier. */
export type ExternalRuntime = ExternalAgent.ChatId

export type ExternalRuntimeStatus = {
  installed: boolean
  // Older desktop builds did not report authentication, so an omitted value
  // remains compatible. An explicit false means every launch would stop at
  // the sign-in wall and must never be presented as ready.
  signedIn?: boolean
}

export type ExternalRuntimeSetup = { id: ExternalRuntime; label: string }

// The platform the app runs on, for picking that platform's official install command.
export function browserPlatform(agent = globalThis.navigator?.userAgent ?? ""): ExternalAgent.Platform {
  if (/Windows/i.test(agent)) return "win32"
  if (/Mac OS X|Macintosh/i.test(agent)) return "darwin"
  return "linux"
}

export const EXTERNAL_RUNTIMES = Object.fromEntries(
  ExternalAgent.chatIds.map((id) => [id, { id, label: ExternalAgent.find(id)!.name }]),
) as Record<ExternalRuntime, ExternalRuntimeSetup>

/** The runtimes in the catalog's order, which is the order every picker lists them in. */
export const EXTERNAL_RUNTIME_IDS: readonly ExternalRuntime[] = ExternalAgent.chatIds

export function isExternalRuntime(value: string): value is ExternalRuntime {
  return ExternalAgent.isChatId(value)
}

export function externalRuntimeSetup(runtime: string): ExternalRuntimeSetup | undefined {
  return isExternalRuntime(runtime) ? EXTERNAL_RUNTIMES[runtime] : undefined
}

export function externalRuntimeReady(status: ExternalRuntimeStatus | undefined) {
  return Boolean(status?.installed && status.signedIn !== false)
}
