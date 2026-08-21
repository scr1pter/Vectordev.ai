import { Show, type Component } from "solid-js"

// Display identities for the engine's built-in subagents. The engine ids and
// their descriptions live in packages/opencode/src/agent/agent.ts and must not
// change — the model routes delegation off those descriptions. This is a
// presentation layer keyed by engine id, so a user-defined agent simply has no
// identity and renders exactly as it did before.
export type SubagentIdentity = {
  id: string
  petName: string
  species: string
  tagline: string
  role: string
  hue: number
}

export const SUBAGENT_IDENTITIES: Record<string, SubagentIdentity> = {
  explore: {
    id: "explore",
    petName: "Scout",
    species: "fox",
    tagline: "Finds anything, fast.",
    role: "Searches and maps the codebase before the work starts.",
    hue: 25,
  },
  general: {
    id: "general",
    petName: "Atlas",
    species: "tortoise",
    tagline: "Slow is smooth, smooth is fast.",
    role: "Carries multi-step research and execution end to end.",
    hue: 150,
  },
  judge: {
    id: "judge",
    petName: "Veri",
    species: "owl",
    tagline: "Show me the evidence.",
    role: "Returns an independent PASS, FAIL or INCONCLUSIVE verdict.",
    hue: 265,
  },
  debug: {
    id: "debug",
    petName: "Pip",
    species: "tree frog",
    tagline: "Every bug gets caught.",
    role: "Reproduces failures and isolates their root cause.",
    hue: 95,
  },
  migration: {
    id: "migration",
    petName: "Tern",
    species: "arctic tern",
    tagline: "No journey too far.",
    role: "Moves frameworks, dependencies, APIs and schemas forward.",
    hue: 200,
  },
  performance: {
    id: "performance",
    petName: "Bolt",
    species: "cheetah",
    tagline: "Make it fast, keep it right.",
    role: "Profiles hot paths, builds and bundles.",
    hue: 45,
  },
  review: {
    id: "review",
    petName: "Quill",
    species: "hedgehog",
    tagline: "Sharp eyes, small notes.",
    role: "Reads a diff and reports findings with file and line.",
    hue: 320,
  },
  security: {
    id: "security",
    petName: "Rook",
    species: "raven",
    tagline: "Watches the boundaries.",
    role: "Inspects trust boundaries, auth and injection surfaces.",
    hue: 220,
  },
  test: {
    id: "test",
    petName: "Echo",
    species: "lyrebird",
    tagline: "Repeats it perfectly.",
    role: "Designs coverage and writes or repairs tests.",
    hue: 175,
  },
}

export function subagentIdentity(id: string | undefined): SubagentIdentity | undefined {
  if (!id) return undefined
  return SUBAGENT_IDENTITIES[id]
}

// One shared geometric face so the nine read as a set rather than nine
// unrelated drawings: the same head, the same eyes, and one species-carrying
// feature drawn behind it. Tinted from the identity's hue against a dark base
// so they hold up on Vector's surfaces at both 16px and 40px.
export const SubagentAvatar: Component<{ id: string; size?: number }> = (props) => {
  const identity = () => subagentIdentity(props.id)
  const size = () => props.size ?? 16
  const accent = () => `hsl(${identity()!.hue} 62% 62%)`
  const deep = () => `hsl(${identity()!.hue} 48% 34%)`
  const species = () => identity()!.species

  return (
    <Show when={identity()}>
      <svg
        width={size()}
        height={size()}
        viewBox="0 0 24 24"
        role="img"
        aria-label={`${identity()!.petName}, the ${species()}`}
        style={{ "flex-shrink": 0 }}
      >
        {/* Species feature, drawn behind the head. */}
        <Show when={species() === "fox" || species() === "cheetah" || species() === "hedgehog"}>
          <path d="M5.6 8.4 4.2 3.9l4.3 2.5M18.4 8.4l1.4-4.5-4.3 2.5" fill={deep()} stroke="none" />
        </Show>
        <Show when={species() === "owl" || species() === "raven" || species() === "lyrebird"}>
          <path d="M4.6 9.2 2.4 6.1l3.3.6M19.4 9.2l2.2-3.1-3.3.6" fill={deep()} stroke="none" />
        </Show>
        <Show when={species() === "tortoise"}>
          <path d="M3.4 13.5a8.6 6 0 0 1 17.2 0Z" fill={deep()} stroke="none" opacity="0.85" />
        </Show>
        <Show when={species() === "tree frog"}>
          <circle cx="6.4" cy="7.4" r="2.9" fill={deep()} />
          <circle cx="17.6" cy="7.4" r="2.9" fill={deep()} />
        </Show>
        <Show when={species() === "arctic tern"}>
          <path d="M3.1 8.2 7 10.4 3.6 11.7ZM20.9 8.2 17 10.4l3.4 1.3Z" fill={deep()} stroke="none" />
        </Show>

        <rect x="4.6" y="6.6" width="14.8" height="13" rx="6.2" fill={accent()} />
        <rect x="4.6" y="6.6" width="14.8" height="13" rx="6.2" fill="#0d0b12" opacity="0.24" />
        <circle cx="9.5" cy="12.4" r="1.65" fill="#0d0b12" />
        <circle cx="14.5" cy="12.4" r="1.65" fill="#0d0b12" />
        <circle cx="10.05" cy="11.85" r="0.5" fill="#fff" opacity="0.9" />
        <circle cx="15.05" cy="11.85" r="0.5" fill="#fff" opacity="0.9" />

        {/* Beak for the birds, muzzle for everything else. */}
        <Show
          when={species() === "owl" || species() === "raven" || species() === "lyrebird" || species() === "arctic tern"}
          fallback={<path d="M10.9 15.6h2.2" stroke="#0d0b12" stroke-width="1.3" stroke-linecap="round" fill="none" />}
        >
          <path d="M12 14.7 13.5 16.4 10.5 16.4Z" fill="#0d0b12" />
        </Show>
      </svg>
    </Show>
  )
}
