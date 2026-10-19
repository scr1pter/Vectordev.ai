export * as BrainPack from "./pack"

// One budget per request for memory and documents alike: the knapsack. Candidates are taken greedily by what each adds
// per token, where a second card from the same section or document adds less than the first did, so a request gets the
// few lines that matter from several places rather than a page of one. The budget is a ceiling, never a target: when
// what is left is worth little next to the best pick, packing stops, and nothing eligible costs nothing.

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
/** Packing stops once the next pick would add less than this share of the first pick's worth. */
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
      return [{ bundle, cost, worth: bundle.reduce((sum, member) => sum + marginal(member), 0) }]
    })
    const best = options.toSorted(
      (a, b) => b.worth / b.cost - a.worth / a.cost || b.worth - a.worth || a.bundle[0]!.id.localeCompare(b.bundle[0]!.id),
    )[0]
    if (!best) break
    if (state.first > 0 && best.worth < STOP * state.first) break
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
