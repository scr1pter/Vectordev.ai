// What the Memory page says about each entry, kept apart from the page so the wording is tested and stays honest.

export type MemoryKind = "rule" | "preference" | "decision" | "lesson" | "fact" | "failure" | "review"
export type MemoryStatus = "active" | "proposed" | "quarantined" | "archived" | "superseded"
export type MemoryHold =
  | "web"
  | "mcp"
  | "subagent"
  | "untrusted-repository"
  | "guest"
  | "instruction-like"
  | "hidden-unicode"
  | "hidden-text"
  | "suggested"

export type MemoryEntryView = {
  id: string
  scope: "repository" | "personal"
  kind: MemoryKind
  origin: "file" | "user" | "agent" | "failure-memory"
  status: MemoryStatus
  pinned: boolean
  text: string
  paths: readonly string[]
  uses: number
  stale: boolean
  hold?: MemoryHold
  source?: { file: string; line?: number }
  lastUsedAt?: number
  createdAt?: number
  updatedAt: number
  /** Learned from a private document: kept from guests and from models that may train on prompts. */
  private?: boolean
}

export type MemoryFiles = { memory: string; rules: string; repository: readonly string[] }

export type MemoryFilter = "active" | "review" | "archived" | "all"

export const MEMORY_FILTERS: readonly { value: MemoryFilter; label: string }[] = [
  { value: "active", label: "In use" },
  { value: "review", label: "Needs review" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "Everything" },
]

export const MEMORY_KINDS: readonly { value: "preference" | "decision" | "lesson" | "fact"; label: string }[] = [
  { value: "lesson", label: "Lesson" },
  { value: "decision", label: "Decision" },
  { value: "preference", label: "Preference" },
  { value: "fact", label: "Fact" },
]

export function kindLabel(kind: MemoryKind) {
  return {
    rule: "Rule",
    preference: "Preference",
    decision: "Decision",
    lesson: "Lesson",
    fact: "Fact",
    failure: "Past failure",
    review: "Review note",
  }[kind]
}

function basename(file: string) {
  return file.split(/[\\/]/).pop() ?? file
}

/** Where an entry comes from, in the words the page shows under it. */
export function originLabel(entry: Pick<MemoryEntryView, "origin" | "source" | "scope">, files?: MemoryFiles) {
  if (entry.origin === "user") return "You added this"
  if (entry.origin === "agent") return "Vector learned this"
  if (entry.origin === "failure-memory") return "Failure memory from checks Vector ran"
  const file = entry.source?.file ?? ""
  if (files && file === files.memory) return "From your MEMORY.md"
  if (files && file === files.rules) return "From your RULES.md"
  const name = basename(file)
  if (name === "BRAIN.md") return "From the repository's BRAIN.md (read-only)"
  if (name === "RULES.md") return "From the repository's .vector/RULES.md"
  return name ? `From ${name}` : "From a file"
}

/** Why an entry waits for the user before Vector uses it. */
export function holdLabel(hold: MemoryHold | undefined) {
  if (hold === "web")
    return "Learned in a session that read web content, held an imported transcript or an issue's text, or ran a command that reaches outside this computer."
  if (hold === "mcp") return "Learned in a session that used an MCP tool or an MCP server's prompt."
  if (hold === "subagent") return "Learned from a subagent's report."
  if (hold === "guest") return "Learned while an invited guest was in the session."
  if (hold === "untrusted-repository") return "This repository's settings are not trusted yet, so its memory waits."
  if (hold === "instruction-like") return "It reads like an instruction to the agent, so it waits for you."
  if (hold === "hidden-unicode") return "It contains hidden characters. Fix the file to use it."
  if (hold === "hidden-text") return "It has text a reader of the document would not see, so it waits for you."
  if (hold === "suggested") return "Vector offered to keep it without you asking, so it waits for you."
  return "An earlier version of Vector held this because it could not check its evidence. It is used once you approve it."
}

/**
 * What the page says once the user adds a memory: what the engine kept, not what was typed. The engine stores the
 * user's words as a new entry beside any that say something similar (it never replaces one on its own), but it removes
 * a secret and keeps one copy of the same words.
 */
export function savedNotice(entry: Pick<MemoryEntryView, "text" | "status" | "updatedAt" | "createdAt">, typed: string) {
  if (entry.status !== "active") return "Saved for your review. Vector uses it once you approve it."
  if (entry.createdAt !== undefined && entry.updatedAt - entry.createdAt > 1000)
    return `This was already in memory, and it is in use: "${entry.text}"`
  if (entry.text.includes("[redacted]") && !typed.includes("[redacted]"))
    return "Saved without the secret it contained. Vector will use it when it is relevant."
  return "Saved. Vector will use it when it is relevant."
}

/** Only what Vector or the user saved here can be edited here; a file someone wrote is changed in that file. */
export function editable(entry: Pick<MemoryEntryView, "origin">) {
  return entry.origin === "user" || entry.origin === "agent"
}

/** Where to change an entry that comes from a file: the user's own file by name, a repository file by its path in it. */
export function fileLabel(file: string, files?: MemoryFiles, root?: string) {
  if (files && file === files.memory) return "your MEMORY.md"
  if (files && file === files.rules) return "your RULES.md"
  const base = root?.replace(/[\\/]+$/, "")
  if (base && (file.startsWith(`${base}/`) || file.startsWith(`${base}\\`))) return file.slice(base.length + 1).replaceAll("\\", "/")
  return basename(file)
}

/** Pinning puts an entry in every request; rules are already there, and review notes only ever go to reviews. */
export function pinnable(entry: Pick<MemoryEntryView, "kind" | "status">) {
  return entry.status === "active" && entry.kind !== "rule" && entry.kind !== "review"
}

export function forgettable(entry: Pick<MemoryEntryView, "origin">) {
  return entry.origin !== "file"
}

export function approvable(entry: Pick<MemoryEntryView, "status" | "origin" | "hold">) {
  if (entry.status !== "proposed" && entry.status !== "quarantined") return false
  if (entry.origin === "file" || entry.origin === "failure-memory") return entry.hold === "instruction-like"
  return true
}

export function rejectable(entry: Pick<MemoryEntryView, "status" | "origin">) {
  return (entry.status === "proposed" || entry.status === "quarantined") && editable(entry)
}

/** How many of Recently learned show before "Show all". */
export const RECENT = 8

/** What the page says once the user undoes something Vector learned. */
export const UNDONE = "Undone. Vector will not learn it again; restore it from Archived to bring it back."

export function summary(stats: { active: number; review: number; archived: number; digestTokens: number }) {
  return [
    `${stats.active} in use`,
    ...(stats.review > 0 ? [`${stats.review} to review`] : []),
    ...(stats.archived > 0 ? [`${stats.archived} archived`] : []),
    stats.digestTokens > 0
      ? `about ${stats.digestTokens.toLocaleString()} tokens in every request`
      : "nothing added to requests until there is memory",
  ].join(" · ")
}

export function usage(entry: Pick<MemoryEntryView, "uses" | "lastUsedAt">, now = Date.now()) {
  if (!entry.uses || !entry.lastUsedAt) return "Not used yet"
  const days = Math.floor((now - entry.lastUsedAt) / 86_400_000)
  const when = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`
  return `Used ${entry.uses} time${entry.uses === 1 ? "" : "s"}, last ${when}`
}
