// Pairing logic for the parallel-agent composer's "Who can message whom" editor.
// It lives beside layout-new.tsx rather than inside it so it can be exercised
// without loading the whole page, which is what let the last bug here ship: the
// renderer's declaration of `agentTeams.getGraph` drifted from what main
// actually returns and nothing could reach the code that then threw.
//
// These types mirror packages/desktop/src/main/agent-team-model.ts. The app
// package cannot import them — desktop depends on app, not the reverse — so the
// declarations are duplicated by hand and must match the source of truth in
// packages/desktop/src/preload/types.ts exactly.
export type TeamLink = {
  from: string
  to: string
  mutual?: boolean
}

export type TeamCollaborationGraph = {
  links: TeamLink[]
}

export type CollaborationShape = "all" | "coordinator" | "custom"

// The graph is drawn before the agents it describes exist, so a member this
// launch is about to create is held under a placeholder id and swapped for the
// real workspace id once the record comes back.
export const PENDING_MEMBER_PREFIX = "pending:"

export const collaborationLinkKey = (from: string, to: string) => `${from}>${to}`

export type CollaborationSelection = {
  shape: CollaborationShape
  coordinator: string | undefined
  links: string[]
}

// Decodes what `agentTeams.getGraph` hands back into the composer's pairing
// state. `undefined` means the payload could not be read as a graph — the team
// was deleted, or main and this file disagree about the payload shape — and the
// caller must then leave the editor alone *and* refuse to persist over the
// team's stored pairing. An editor still showing its "Everyone" default is not
// the user having chosen "Everyone".
export function adoptCollaborationGraph(
  result: { explicit: boolean; graph: TeamCollaborationGraph } | undefined,
  memberIds: readonly string[],
): CollaborationSelection | undefined {
  // Asserted at runtime, not just in the type: this payload crosses the preload
  // boundary from a package TypeScript cannot check against from here. `explicit`
  // is checked as strictly as the links because a payload that lost it would read
  // as the all-to-all default, which both hides the user's pairing and tells the
  // launch it is safe to clear it — the drift this whole module exists to survive.
  if (!result || typeof result.explicit !== "boolean" || !Array.isArray(result.graph?.links)) return undefined
  // `explicit: false` is main synthesising the all-to-all default for a team
  // that never stored a graph. Adopting those links as a drawn "custom" matrix
  // would pin today's mesh into storage on the next launch, so the default is
  // adopted as the default.
  if (!result.explicit) return { shape: "all", coordinator: undefined, links: [] }
  const coordinator = coordinatorInGraph(result.graph, memberIds)
  return {
    shape: coordinator ? "coordinator" : "custom",
    coordinator,
    // A mutual link is one stored row standing for both directions, so it
    // becomes two checked cells. Collapsing it to the single forward cell would
    // show the team as more restricted than it is, and saving from the custom
    // matrix — which only ever emits directed rows — would then silently revoke
    // the reply permission the user never unchecked.
    links: result.graph.links.flatMap((link) =>
      link.mutual === true
        ? [collaborationLinkKey(link.from, link.to), collaborationLinkKey(link.to, link.from)]
        : [collaborationLinkKey(link.from, link.to)],
    ),
  }
}

// Whether a launch may write `graph` over the team's stored pairing. `graph` is
// undefined both when the user picked "Everyone" and when adoption failed and
// left the editor at its "Everyone" default; only the first may clear what is
// stored. Writing the second is silent data loss — the user configured a
// pairing, joined the team, and would find it erased on the next launch.
export function shouldPersistCollaborationGraph(input: {
  teamId: string
  graph: TeamCollaborationGraph | undefined
  joinedTeamId: string | undefined
  adoptedTeamId: string | undefined
}) {
  // A graph the user drew is always written, including when adoption failed.
  // Picking a team clears the editor's links before the read is awaited, so
  // anything drawn afterwards is this launch's own configuration rather than
  // pairing inherited from the team the user moved off. Refusing it would trade
  // the wipe this guard closes for a silent drop of the pairing just drawn.
  if (input.graph) return true
  // A brand-new team has nothing stored to clear, so "Everyone" writes nothing.
  if (!input.joinedTeamId) return false
  return input.adoptedTeamId === input.teamId
}

// A stored graph is only recognisable as the coordinator shape when exactly one
// member is mutually linked to every other; anything else is custom.
function coordinatorInGraph(graph: TeamCollaborationGraph, memberIds: readonly string[]) {
  const candidate = graph.links[0]?.from
  if (!candidate || graph.links.length !== memberIds.length - 1) return undefined
  if (!graph.links.every((link) => link.from === candidate && link.mutual === true)) return undefined
  return candidate
}
