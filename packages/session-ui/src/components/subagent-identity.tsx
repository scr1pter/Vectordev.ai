import { Show, type Component } from "solid-js"

// Display identities for the engine's built-in subagents. The engine ids and
// their descriptions live in packages/opencode/src/agent/agent.ts and must not
// change — the model routes delegation off those. This is a presentation layer
// keyed by engine id, so a user-defined agent has no identity here and renders
// exactly as it did before.
export type SubagentIdentity = {
  id: string
  name: string
  summary: string
  detail: string
  hue: number
  readOnly?: boolean
}

export const SUBAGENT_IDENTITIES: Record<string, SubagentIdentity> = {
  explore: {
    id: "explore",
    name: "Explore",
    summary: "Finds code fast",
    detail: "Searches the repository by pattern or keyword and maps how it fits together before the work starts.",
    hue: 25,
  },
  general: {
    id: "general",
    name: "General",
    summary: "Multi-step work",
    detail: "Researches open-ended questions and carries multi-step tasks through to a result.",
    hue: 150,
  },
  judge: {
    id: "judge",
    name: "Judge",
    summary: "Verifies completion",
    detail:
      "Scores the finished work against the original request — coverage, correctness, regression safety, evidence — and returns PASS, FAIL or INCONCLUSIVE. Runs only when verified completion is enabled.",
    hue: 265,
    readOnly: true,
  },
  debug: {
    id: "debug",
    name: "Debug",
    summary: "Finds root causes",
    detail: "Reproduces a failure, isolates the cause, applies a focused repair and re-checks that it holds.",
    hue: 95,
  },
  migration: {
    id: "migration",
    name: "Migration",
    summary: "Upgrades safely",
    detail:
      "Plans and stages framework, dependency, API, schema and configuration upgrades across their compatibility boundaries.",
    hue: 200,
  },
  performance: {
    id: "performance",
    name: "Performance",
    summary: "Makes it faster",
    detail:
      "Measures a baseline, then optimises slow runtime paths, builds, bundles, queries and rendering against it.",
    hue: 45,
  },
  review: {
    id: "review",
    name: "Review",
    summary: "Reads the diff",
    detail:
      "Inspects a change for correctness, regressions, missing tests and maintainability, reporting findings with file and line. Never edits.",
    hue: 320,
    readOnly: true,
  },
  security: {
    id: "security",
    name: "Security",
    summary: "Checks the boundaries",
    detail:
      "Reviews trust boundaries, authentication, secrets, injection risk and unsafe data flow. Never edits.",
    hue: 220,
    readOnly: true,
  },
  test: {
    id: "test",
    name: "Test",
    summary: "Writes coverage",
    detail: "Designs focused coverage, writes or repairs tests, runs the suite and reports failures with evidence.",
    hue: 175,
  },
}

export function subagentIdentity(id: string | undefined): SubagentIdentity | undefined {
  if (!id) return undefined
  return SUBAGENT_IDENTITIES[id]
}

// One shared mark per subagent: a rounded tile carrying a glyph that stands for
// what the agent does, tinted from its own hue. Deliberately abstract rather
// than illustrative so the set reads as a toolkit and stays legible at 16px.
export const SubagentAvatar: Component<{ id: string; size?: number }> = (props) => {
  const identity = () => subagentIdentity(props.id)
  const size = () => props.size ?? 16
  const accent = () => `hsl(${identity()!.hue} 68% 66%)`
  const tile = () => `hsl(${identity()!.hue} 42% 22%)`

  return (
    <Show when={identity()}>
      <svg
        width={size()}
        height={size()}
        viewBox="0 0 24 24"
        role="img"
        aria-label={identity()!.name}
        style={{ "flex-shrink": 0 }}
      >
        <rect x="1.5" y="1.5" width="21" height="21" rx="6.5" fill={tile()} />
        <rect x="1.5" y="1.5" width="21" height="21" rx="6.5" fill="none" stroke={accent()} stroke-opacity="0.35" />
        <g fill="none" stroke={accent()} stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          {/* explore: a magnifier */}
          <Show when={props.id === "explore"}>
            <circle cx="10.8" cy="10.8" r="4.1" />
            <path d="M13.9 13.9 17.4 17.4" />
          </Show>
          {/* general: stacked units of work */}
          <Show when={props.id === "general"}>
            <path d="M6.4 8h11.2M6.4 12h11.2M6.4 16h7" />
          </Show>
          {/* judge: a balance */}
          <Show when={props.id === "judge"}>
            <path d="M12 6v12M7 9h10M8.4 9l-2 4h4zM15.6 9l-2 4h4z" />
          </Show>
          {/* debug: a bug */}
          <Show when={props.id === "debug"}>
            <rect x="8.6" y="8.4" width="6.8" height="8.2" rx="3.4" />
            <path d="M6.2 10.4h2.4M15.4 10.4h2.4M6.2 14.6h2.4M15.4 14.6h2.4M10 6.6l1.2 1.8M14 6.6l-1.2 1.8" />
          </Show>
          {/* migration: a forward arrow crossing a boundary */}
          <Show when={props.id === "migration"}>
            <path d="M5.6 12h10.6M13.2 8.6 16.6 12l-3.4 3.4M18.6 6.6v10.8" />
          </Show>
          {/* performance: a rising trace */}
          <Show when={props.id === "performance"}>
            <path d="M5.8 16.6 10 11.4l3 2.8 5.2-6.4" />
            <path d="M14.6 7.8h3.6v3.6" />
          </Show>
          {/* review: a document with a check */}
          <Show when={props.id === "review"}>
            <path d="M7.4 5.8h6.4l3.4 3.4v9a1 1 0 0 1-1 1H7.4a1 1 0 0 1-1-1V6.8a1 1 0 0 1 1-1Z" />
            <path d="M9.4 13.6l1.9 1.9 3.6-3.9" />
          </Show>
          {/* security: a shield */}
          <Show when={props.id === "security"}>
            <path d="M12 5.6 17.6 8v4c0 3.2-2.3 5.6-5.6 6.6-3.3-1-5.6-3.4-5.6-6.6V8Z" />
          </Show>
          {/* test: a flask */}
          <Show when={props.id === "test"}>
            <path d="M10.2 5.8v4.4L6.6 16.4a1.4 1.4 0 0 0 1.2 2.2h8.4a1.4 1.4 0 0 0 1.2-2.2l-3.6-6.2V5.8" />
            <path d="M9.2 5.8h5.6M8.6 13.6h6.8" />
          </Show>
        </g>
      </svg>
    </Show>
  )
}
