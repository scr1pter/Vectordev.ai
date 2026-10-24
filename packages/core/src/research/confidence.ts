export * as ResearchConfidence from "./confidence"

import type { Research } from "@vectordevai/schema/research"

// Vector's estimate of how well a report section is supported, from its cited notes alone. The rule is shown on hover
// and is the same every time:
// - High: quotes that state the claim from at least 2 independent sites, one of them a primary source, nothing
//   contradicting, and, when the judge ran, every cited note judged supported.
// - Medium: one supporting primary source, or 2 independent sites, with nothing contradicting.
// - Low: everything else, and any section with a contradicting note, which shows "Sources disagree".
// Notes the judge found unsupported are left out and listed under "Removed after checking".

export type Level = "high" | "medium" | "low"

export const LABEL: Readonly<Record<Level, string>> = { high: "High", medium: "Medium", low: "Low" }

export const HOVER =
  "Vector's estimate. High: at least two independent sites with quotes that support the claim, one of them a primary source, and nothing contradicting it."

export const DISAGREE = "Sources disagree"

/** A note cited in a section, with the site of its source and whether that source is primary. */
export type Cited = { readonly note: Research.Note; readonly site: string; readonly primary: boolean }

export type Result = {
  readonly level: Level
  /** Sources disagree: a cited note contradicts the section. */
  readonly disagree: boolean
  /** Notes the judge found unsupported, left out of the estimate. */
  readonly removed: readonly string[]
}

export function section(cited: readonly Cited[], options: { readonly judged: boolean }): Result {
  const removed = cited.filter((item) => item.note.verdict === "unsupported")
  const counted = cited.filter((item) => item.note.verdict !== "unsupported")
  const result = (level: Level, disagree = false): Result => ({
    level,
    disagree,
    removed: removed.map((item) => item.note.id),
  })
  if (counted.some((item) => item.note.stance === "contradicts" || item.note.verdict === "contradicted"))
    return result("low", true)
  const supporting = counted.filter((item) => item.note.stance === "supports")
  // A paraphrase (a quote that does not state the claim) supports a Medium estimate, never a High one.
  const stated = supporting.filter((item) => item.note.support)
  const judged = !options.judged || counted.every((item) => item.note.verdict === "supported")
  if (sites(stated) >= 2 && stated.some((item) => item.primary) && judged) return result("high")
  if (supporting.some((item) => item.primary) || sites(supporting) >= 2) return result("medium")
  return result("low")
}

function sites(cited: readonly Cited[]) {
  return new Set(cited.map((item) => item.site)).size
}
