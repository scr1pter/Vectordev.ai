import { ExternalAgent } from "@vectordevai/schema/external-agent"

// Setup details for the third-party coding agents Vector can run as a workspace
// engine, derived from the one catalog in @vectordevai/schema/external-agent that
// desktop detection reads too. Vector shells out to the user's own CLI, so these
// are the commands that make each runtime available — a picker that only says
// "Setup needed" leaves the user with nowhere to go.

/** A runtime Vector can run in its own chat view: the catalog's "chat" tier. */
export type ExternalRuntime = ExternalAgent.ChatId

export type ExternalRuntimeStatus = {
  installed: boolean
  // Older desktop builds did not report authentication, so an omitted value
  // remains compatible. An explicit false means every launch would stop at
  // the sign-in wall and must never be presented as ready.
  signedIn?: boolean
}

export type ExternalRuntimeSetup = {
  id: ExternalRuntime
  label: string
  cli: string
  installCommand: string
  signInCommand?: string
  note: string
  docsUrl: string
}

// The platform the app runs on, for picking that platform's official install command.
export function browserPlatform(agent = globalThis.navigator?.userAgent ?? ""): ExternalAgent.Platform {
  if (/Windows/i.test(agent)) return "win32"
  if (/Mac OS X|Macintosh/i.test(agent)) return "darwin"
  return "linux"
}

export const EXTERNAL_RUNTIMES = Object.fromEntries(
  ExternalAgent.chatIds.map((id) => {
    const agent = ExternalAgent.find(id)!
    const setup: ExternalRuntimeSetup = {
      id,
      label: agent.name,
      cli: agent.binaries[0]!.name,
      installCommand: ExternalAgent.installFor(agent, browserPlatform())[0]?.command ?? "",
      signInCommand: ExternalAgent.signInCommand(agent),
      note: `Runs your installed ${agent.name} in an isolated copy of the repository. Vector never reads its sign-in.`,
      docsUrl: agent.docsUrl,
    }
    return [id, setup]
  }),
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

// Every step a user must complete before the runtime can be selected, in order.
export function setupSteps(runtime: ExternalRuntime, mode: "install" | "sign-in" = "install") {
  const setup = EXTERNAL_RUNTIMES[runtime]
  const signIn = setup.signInCommand ? [{ label: "Sign in", command: setup.signInCommand }] : []
  // An installed CLI that is merely signed out needs one step, not two: showing
  // the install command again reads as "reinstall it", which is the wrong fix.
  if (mode === "sign-in") return signIn
  return [{ label: "Install", command: setup.installCommand }, ...signIn]
}
