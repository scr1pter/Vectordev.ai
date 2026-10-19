import type { Part as PartType } from "@vectordevai/sdk/v2"

// Citations in an answer: the agent cites memory and document cards as [id] when it relies on one. A citation is shown
// as a solid chip only when that id was delivered to the model in this session (recalled for a request, returned by a
// memory tool call, or kept from an attachment); any other id in that shape is shown as plain text marked unverified,
// so a made-up or mistyped id never looks like a source. The transcript keeps ids only, so what a chip says on hover
// comes from the owner's engine; a guest sees the id alone.

/** Metadata keys the engine writes (SessionMemory in the engine). */
export const RECALL = "vector.memory.recall"
export const KNOWLEDGE = "vector.memory.knowledge"
export const PERSONAL = "vector.memory.personal"
/** The code-link lines a read or an edit carried: `{ mode, file, ids }[]`. */
export const LINKS = "vector.memory.links"

// Ids by kind, in the brain's Crockford base32: memory entries (m, 5 or 13), file entries (f, 6), records (r, 12),
// passages (p, 12) and documents (d, 8). Exact lengths keep words such as "[demand]" from reading as an id.
const ID =
  "(?:m(?:[0-9a-hjkmnp-tv-z]{13}|[0-9a-hjkmnp-tv-z]{5})|f[0-9a-hjkmnp-tv-z]{6}|[rp][0-9a-hjkmnp-tv-z]{12}|d[0-9a-hjkmnp-tv-z]{8})"
const CITATION = new RegExp(`\\[(${ID})\\]`, "g")
const BARE = new RegExp(`^${ID}$`)

export type Segment = { type: "text"; text: string } | { type: "citation"; id: string; verified: boolean }

/** Whether text may hold a citation at all, so most answers skip the rest. */
export function cites(text: string) {
  return text.search(CITATION) !== -1
}

/** Text cut into plain runs and citations, each marked verified when its id was delivered. */
export function segments(text: string, delivered: ReadonlySet<string>): Segment[] {
  const found = [...text.matchAll(CITATION)]
  if (found.length === 0) return [{ type: "text", text }]
  const state = { at: 0, out: [] as Segment[] }
  for (const match of found) {
    const start = match.index ?? 0
    if (start > state.at) state.out.push({ type: "text", text: text.slice(state.at, start) })
    const id = match[1] ?? ""
    state.out.push({ type: "citation", id, verified: delivered.has(id) })
    state.at = start + match[0].length
  }
  if (state.at < text.length) state.out.push({ type: "text", text: text.slice(state.at) })
  return state.out
}

/** Every id the model was given in these parts: what recall put in a request, and what memory tool calls returned. */
export function delivered(parts: readonly PartType[]) {
  return new Set(
    parts.flatMap((part) => {
      if (part.type === "text") {
        const recall = recallOf(part)
        const knowledge = knowledgeOf(part.synthetic ? part.metadata : undefined)
        return [...(recall ? [...recall.ids, ...recall.cards, ...recall.personal] : []), ...knowledge]
      }
      if (part.type !== "tool" || part.state.status !== "completed") return []
      const metadata = part.state.metadata
      // A read that pointed at linked documents, and an edit that named the requirements linked to the file it
      // changed, name their ids.
      const linked = (Array.isArray(metadata?.[LINKS]) ? (metadata[LINKS] as unknown[]) : []).flatMap((item) =>
        item && typeof item === "object" && "ids" in item ? strings(item.ids).filter((id) => BARE.test(id)) : [],
      )
      if (part.tool === "read")
        return [
          ...linked,
          ...strings(metadata?.loaded).flatMap((item) =>
            item.startsWith("knowledge:")
              ? item
                  .slice("knowledge:".length)
                  .split(",")
                  .filter((id) => BARE.test(id))
              : [],
          ),
        ]
      if (part.tool === "edit" || part.tool === "write" || part.tool === "apply_patch") return linked
      if (part.tool !== "memory") return []
      return [
        ...knowledgeOf(metadata),
        ...strings(metadata?.[PERSONAL]),
        ...(typeof metadata?.id === "string" && BARE.test(metadata.id) ? [metadata.id] : []),
        // What the tool printed is what the model read, ids included.
        ...[...part.state.output.matchAll(CITATION)].flatMap((match) => (match[1] ? [match[1]] : [])),
      ]
    }),
  )
}

export type Recall = {
  ids: string[]
  cards: string[]
  personal: string[]
  tokens: number
  why: Record<string, string>
  /** Kinds of the repository entries, read from the saved lines ("- [m3k2a] lesson: …"). */
  kinds: Record<string, string>
}

/** What recall put in a request, from the synthetic part that carries it. */
export function recallOf(part: PartType): Recall | undefined {
  if (part.type !== "text") return undefined
  const value = part.metadata?.[RECALL]
  if (!value || typeof value !== "object") return undefined
  const why = "why" in value && value.why && typeof value.why === "object" ? value.why : {}
  return {
    ids: "ids" in value ? strings(value.ids) : [],
    cards: "cards" in value ? strings(value.cards) : [],
    personal: "personal" in value ? strings(value.personal) : [],
    tokens: "tokens" in value && typeof value.tokens === "number" ? value.tokens : 0,
    why: Object.fromEntries(
      Object.entries(why).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    kinds: Object.fromEntries(
      [...(part.text ?? "").matchAll(new RegExp(`^- \\[(${ID})\\] ([a-z-]+)`, "gm"))].map((match) => [
        match[1] ?? "",
        match[2] ?? "",
      ]),
    ),
  }
}

/** What a citation chip says on hover, from the owner's engine. */
export type KnowledgeCard = {
  id: string
  kind: string
  title?: string
  page?: number
  section?: string
  text: string
}

const KIND_LABEL: Record<string, string> = {
  requirement: "requirement",
  constraint: "constraint",
  decision: "decision",
  contract: "contract",
  procedure: "procedure",
  term: "term",
  entity: "entity",
  fact: "fact",
  question: "open question",
  passage: "passage",
  document: "document",
  rule: "rule",
  preference: "preference",
  lesson: "lesson",
  failure: "past failure",
  review: "review note",
}

/** Where in its document a card comes from: "p.14", or its section ("§3.2", or "§Limits" for an unnumbered one). */
export function locator(card: Pick<KnowledgeCard, "page" | "section">) {
  if (card.page !== undefined) return `p.${card.page}`
  const last = card.section?.split(" > ").at(-1)?.trim()
  if (!last) return ""
  const numbered = /^(\d+(?:\.\d+)*)\b/.exec(last)
  if (numbered) return `§${numbered[1]}`
  return `§${last.length > 24 ? `${last.slice(0, 23).trimEnd()}…` : last}`
}

/** A chip's hover text: what the card is and where it comes from, then its line. */
export function chipTitle(id: string, card: KnowledgeCard | undefined) {
  if (!card) return `${id}: given to the model in this session`
  const kind = KIND_LABEL[card.kind] ?? card.kind
  const where = [card.title, locator(card)].filter(Boolean).join(" ")
  return `${capital(kind)}${where ? ` · ${where}` : ""}\n${card.text}`
}

export const UNVERIFIED = "Not something Vector gave the model in this session, so this citation is not verified."

/** Why recall chose an item, from its `why` code. Never sent to the model. */
export function reason(code: string | undefined) {
  if (!code) return "Vector found it relevant to the request."
  if (code === "path") return "It is about a file the request names."
  if (code === "meaning") return "It is close in meaning to the request."
  if (code === "pinned") return "You pinned it, so it goes with every request."
  if (code.startsWith("anchor:")) {
    const file = code.slice("anchor:".length).replace(/:[a-z]+$/, "")
    return `It is linked to ${file}, which the request touches.`
  }
  if (code.startsWith("terms:")) {
    const terms = code
      .slice("terms:".length)
      .split(",")
      .map((term) => term.trim())
      .filter(Boolean)
    return terms.length ? `It shares words with the request: ${terms.join(", ")}.` : "It shares words with the request."
  }
  return "Vector found it relevant to the request."
}

export type Used = {
  /** "3 document cards (API spec p.14, p.22; SLA §2), 1 lesson · 214 tokens" */
  summary: string
  items: { id: string; label: string; text?: string; reason: string }[]
}

/** The "Used from memory" footer of a turn: what recall put in its request, grouped, and why each one. */
export function used(recall: Recall, resolved: ReadonlyMap<string, KnowledgeCard>): Used | undefined {
  if (recall.ids.length === 0) return undefined
  const cards = new Set(recall.cards)
  const documents = recall.ids.filter((id) => cards.has(id))
  const entries = recall.ids.filter((id) => !cards.has(id))
  const groups = documents.reduce<{ title: string; places: string[] }[]>((all, id) => {
    const card = resolved.get(id)
    if (!card?.title) return all
    const place = locator(card)
    const group = all.find((item) => item.title === card.title)
    if (!group) return [...all, { title: card.title, places: place ? [place] : [] }]
    if (place && !group.places.includes(place)) group.places.push(place)
    return all
  }, [])
  const named = groups.map((group) =>
    group.places.length ? `${group.title} ${group.places.slice(0, 4).join(", ")}` : group.title,
  )
  const kinds = entries.reduce((all, id) => {
    const kind = resolved.get(id)?.kind ?? recall.kinds[id] ?? (recall.personal.includes(id) ? "personal" : "entry")
    all.set(kind, (all.get(kind) ?? 0) + 1)
    return all
  }, new Map<string, number>())
  const parts = [
    ...(documents.length
      ? [
          `${documents.length} document card${documents.length === 1 ? "" : "s"}${named.length ? ` (${named.join("; ")})` : ""}`,
        ]
      : []),
    ...[...kinds.entries()].map(([kind, n]) => `${n} ${entryKind(kind, n)}`),
  ]
  return {
    summary: `${parts.join(", ")}${recall.tokens > 0 ? ` · ${recall.tokens.toLocaleString("en-US")} tokens` : ""}`,
    items: recall.ids.map((id) => {
      const card = resolved.get(id)
      const kind = card?.kind ?? recall.kinds[id]
      const where = card ? [card.title, locator(card)].filter(Boolean).join(" ") : ""
      return {
        id,
        label: [kind ? capital(KIND_LABEL[kind] ?? kind) : cards.has(id) ? "Document card" : "Memory", where]
          .filter(Boolean)
          .join(" · "),
        ...(card?.text ? { text: card.text } : {}),
        reason: reason(recall.why[id]),
      }
    }),
  }
}

function entryKind(kind: string, n: number) {
  if (kind === "personal") return n === 1 ? "thing about you" : "things about you"
  if (kind === "entry") return n === 1 ? "memory entry" : "memory entries"
  const label = KIND_LABEL[kind] ?? kind
  return n === 1 ? label : `${label}s`
}

function knowledgeOf(metadata: Record<string, unknown> | undefined) {
  const value = metadata?.[KNOWLEDGE]
  if (!value || typeof value !== "object") return []
  const gets = "get" in value && Array.isArray(value.get) ? value.get : []
  return [
    ...("document" in value && typeof value.document === "string" ? [value.document] : []),
    ...("cards" in value ? strings(value.cards) : []),
    ...(gets as unknown[]).flatMap((item) =>
      item && typeof item === "object" && "id" in item && typeof item.id === "string" ? [item.id] : [],
    ),
  ]
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function capital(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Turns the citations in rendered Markdown into chips: solid for delivered ids, plain text marked unverified for the
 * rest. Code, links and chips already made are left alone, so it can run again after every render.
 */
export function decorateCitations(root: HTMLElement, delivered: ReadonlySet<string>, title: (id: string) => string) {
  for (const chip of root.querySelectorAll<HTMLElement>('[data-component="knowledge-citation"]')) {
    const id = chip.dataset.id ?? ""
    dress(chip, id, delivered.has(id), title)
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('code, pre, a, [data-component="knowledge-citation"]')
        ? NodeFilter.FILTER_REJECT
        : cites(node.nodeValue ?? "")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP,
  })
  const found: Text[] = []
  while (walker.nextNode()) if (walker.currentNode instanceof Text) found.push(walker.currentNode)
  for (const node of found) {
    const fragment = document.createDocumentFragment()
    for (const segment of segments(node.nodeValue ?? "", delivered)) {
      if (segment.type === "text") {
        fragment.append(segment.text)
        continue
      }
      const chip = document.createElement("span")
      chip.dataset.component = "knowledge-citation"
      chip.dataset.id = segment.id
      dress(chip, segment.id, segment.verified, title)
      fragment.append(chip)
    }
    node.replaceWith(fragment)
  }
}

function dress(chip: HTMLElement, id: string, verified: boolean, title: (id: string) => string) {
  chip.dataset.verified = verified ? "true" : "false"
  chip.textContent = verified ? id : `[${id}]`
  chip.title = verified ? title(id) : UNVERIFIED
  chip.setAttribute("aria-label", verified ? `Cited from memory: ${chip.title}` : `[${id}], ${UNVERIFIED}`)
}
