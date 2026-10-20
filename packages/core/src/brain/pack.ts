export * as BrainPack from "./pack"

// One budget per request for memory and documents alike: the knapsack. Candidates are taken greedily by what each adds
// per token, where a second card from the same section or document adds less than the first did, so a request gets the
// few lines that matter from several places rather than a page of one, and the caps per section and document bound how
// many come from one place. The budget is a ceiling, never a target: a card worth little on its own next to the first
// pick is left out, and nothing eligible costs nothing. The discount only orders the picks and never keeps a card out by
// itself, or a section's second requirement, the one a request asks about, could miss the stop line with most of the
// budget left.

export type Candidate = {
  readonly id: string
  /** What it is worth to the request, before diminishing returns. */
  readonly value: number
  /** Tokens it adds, as sent. */
  readonly cost: number
  readonly document?: string
  readonly section?: string
  /** Its subject key: a second card saying something about the same subject is left out. */
  readonly subject?: string
  /** Candidates it disagrees with: they go in together or not at all, so neither side is heard alone. */
  readonly conflicts?: readonly string[]
}

/** What a further card from a section or document already picked from is worth, per card picked there. */
export const SECTION = 0.5
export const DOCUMENT = 0.8
export const PER_SECTION = 2
export const PER_DOCUMENT = 4
/** A card worth less than this share of the first pick's worth, before the discount, is left out. */
export const STOP = 0.15

export function pack<C extends Candidate>(candidates: readonly C[], budget: number): C[] {
  const pool = new Map(candidates.filter((item) => item.cost > 0 && item.value > 0).map((item) => [item.id, item]))
  const picked: C[] = []
  const state = { used: 0, first: 0 }
  const count = (key: "section" | "document", value: string | undefined) =>
    value === undefined ? 0 : picked.filter((item) => item[key] === value).length
  const marginal = (item: C) =>
    item.value * SECTION ** count("section", item.section) * DOCUMENT ** count("document", item.document)
  const allowed = (item: C, others: readonly C[]) => {
    const group = [...others, item]
    const within = (key: "section" | "document", cap: number) =>
      item[key] === undefined ||
      count(key, item[key]) + group.filter((other) => other[key] === item[key]).length <= cap
    return within("section", PER_SECTION) && within("document", PER_DOCUMENT)
  }
  for (;;) {
    // A candidate with a conflict partner still in the pool is offered as the pair.
    const options = [...pool.values()].flatMap((item) => {
      const bundle = [item, ...(item.conflicts ?? []).flatMap((id) => (pool.get(id) && id !== item.id ? [pool.get(id)!] : []))]
      const cost = bundle.reduce((sum, member) => sum + member.cost, 0)
      if (state.used + cost > budget) return []
      if (!bundle.every((member, index) => allowed(member, bundle.slice(0, index)))) return []
      if (state.first > 0 && bundle.reduce((sum, member) => sum + member.value, 0) < STOP * state.first) return []
      return [{ bundle, cost, worth: bundle.reduce((sum, member) => sum + marginal(member), 0) }]
    })
    const best = options.toSorted(
      (a, b) => b.worth / b.cost - a.worth / a.cost || b.worth - a.worth || a.bundle[0]!.id.localeCompare(b.bundle[0]!.id),
    )[0]
    if (!best) break
    for (const member of best.bundle) {
      picked.push(member)
      pool.delete(member.id)
    }
    state.used += best.cost
    if (state.first === 0) state.first = best.worth
    // The same subject said again adds nothing new.
    const subjects = new Set(best.bundle.flatMap((member) => (member.subject ? [member.subject] : [])))
    for (const [id, item] of pool) if (item.subject && subjects.has(item.subject)) pool.delete(id)
  }
  return picked
}
