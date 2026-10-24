import { ExternalAgent } from "@vectordevai/schema/external-agent"

/* What the Host locally launcher shows for each coding agent in the catalog: its badge, its status on this computer
   and the copy around starting, signing in to and installing it. Everything here is derived from the catalog and
   desktop's detection; nothing reads the agents' own files. */

/** A row's status. "checking" is the first detection still running; "unknown" is an agent Vector cannot read the
    sign-in of, or one this desktop build does not detect yet. */
export type HostState = ExternalAgent.State | "checking"

export const STATUS_LABEL: Record<HostState, string> = {
  ready: "Ready",
  "signed-out": "Signed out",
  "not-installed": "Not installed",
  checking: "Checking",
  unknown: "Unknown",
}

export type HostRow = {
  agent: ExternalAgent.Agent
  state: HostState
  detection?: ExternalAgent.Detection
}

/** Every catalog agent in the catalog's order, with what desktop detected for it. */
export function hostRows(detections: readonly ExternalAgent.Detection[], checking: boolean): HostRow[] {
  return ExternalAgent.catalog.map((agent) => {
    const detection = detections.find((item) => item.id === agent.id)
    return { agent, detection, state: hostState(detection, checking) }
  })
}

/** A refresh keeps showing the last known state; only an agent never detected shows Checking. */
export function hostState(detection: ExternalAgent.Detection | undefined, checking: boolean): HostState {
  if (!detection) return checking ? "checking" : "unknown"
  if ((ExternalAgent.states as readonly string[]).includes(detection.state)) return detection.state
  // Desktop builds from before the shared catalog report only installed and signedIn.
  if (!detection.installed) return "not-installed"
  if (detection.signedIn === false) return "signed-out"
  return detection.signedIn ? "ready" : "unknown"
}

/** Whether Start is offered: the agent is installed, even when Vector cannot tell whether it is signed in. */
export function canStart(row: HostRow) {
  return row.state === "ready" || (row.state === "unknown" && row.detection?.installed === true)
}

/** Rows matching every word of the search, by name, vendor, label, command or status. */
export function filterHostRows(rows: readonly HostRow[], term: string) {
  const words = term.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...rows]
  return rows.filter((row) => {
    const haystack = [
      row.agent.name,
      row.agent.vendor,
      row.agent.label ?? "",
      ...row.agent.binaries.map((binary) => binary.name),
      STATUS_LABEL[row.state],
    ]
      .join(" ")
      .toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

export type AgentBadge =
  | { kind: "official"; src: string }
  | { kind: "letters"; letters: string; tone: ExternalAgent.LetterTone }

/** The vendor's own file only where the catalog switches it on; otherwise neutral letters. */
export function agentBadge(agent: ExternalAgent.Agent, scheme: "light" | "dark"): AgentBadge {
  const official = agent.logo.show === "official" ? agent.logo.official : undefined
  if (official) return { kind: "official", src: `/agent-logos/${scheme === "light" ? official.light : official.dark}` }
  return { kind: "letters", letters: agent.logo.letters, tone: agent.logo.tone }
}

export function startCopy(agent: ExternalAgent.Agent) {
  const surface = agent.tier === "chat" ? "Vector's chat" : "Vector's terminal"
  return `Runs your installed ${agent.name} in ${surface}, in an isolated copy of the repository.`
}

export const NOTE_LABEL: Record<ExternalAgent.Note["kind"], string> = {
  billing: "Billing",
  terms: "Terms",
  data: "Your data",
  info: "Note",
}

/** A link from the catalog, only when it is https on one of the agent's own vendor domains. The catalog test holds
    every entry to this; the check here keeps an off-domain link from ever reaching the screen. */
export function vendorLink(agent: ExternalAgent.Agent, raw: string | undefined) {
  if (!raw || !URL.canParse(raw)) return undefined
  const url = new URL(raw)
  if (url.protocol !== "https:") return undefined
  const owned = agent.domains.some((domain) => {
    const [host, ...path] = domain.split("/")
    if (!path.length) return url.hostname === host || url.hostname.endsWith(`.${host}`)
    return url.hostname === host && url.pathname.startsWith(`/${path.join("/")}/`)
  })
  if (!owned) return undefined
  return { href: url.href, label: `${url.hostname}${url.pathname === "/" ? "" : url.pathname}` }
}

/** The model flag a chosen model reaches, as the user would read it (`--model`), for the surface the agent runs on. */
export function modelFlag(agent: ExternalAgent.Agent) {
  const flag = agent.tier === "chat" ? agent.headless?.model : agent.interactive.model
  return flag?.[0]
}

// Desktop refuses any other value before it reaches a command line (MODEL_VALUE_PATTERN in
// packages/desktop/src/main/external-agents.ts): a leading dash would read as a flag, and quotes or shell syntax
// would break the argv. Checking here says so while the user types.
const MODEL_VALUE = /^[A-Za-z0-9][\w.:/@-]{0,127}(?:\[[\w.,=-]{1,128}\])?$/

export function customModelError(value: string) {
  const model = value.trim()
  if (!model || MODEL_VALUE.test(model)) return undefined
  return "Use letters, digits and . _ : / @ - only, starting with a letter or digit."
}

/** The install options to show: desktop's, which carry the launch for the terminal, else the catalog's own commands
    for this platform from an older desktop build that cannot run them. */
export function installOptions(
  agent: ExternalAgent.Agent,
  platform: ExternalAgent.Platform,
  commands: ExternalAgent.Commands | undefined,
): (ExternalAgent.Install & { launch?: ExternalAgent.TerminalLaunch })[] {
  if (commands?.install.length) return [...commands.install]
  return ExternalAgent.installFor(agent, platform)
}
