export * as ResearchSource from "./research-source"

import { ResearchSource } from "@vectordevai/core/research/source"
import type { ResearchReader } from "@vectordevai/core/research/reader"
import type { ResearchStore } from "@vectordevai/core/research/store"
import { Effect } from "effect"
import type { ResearchRun } from "./research-run"

// The engine's side of a saved page (core's research/source.ts): research_read's pages, and the pages a research
// browser or the user's own browser read for the run, saved and shown the way the V2 runner's research_read does.

export type Metadata = ResearchSource.Metadata
export type View = ResearchSource.View

export const MAX_LINKS = ResearchSource.MAX_LINKS
export const OUTBOUND = ResearchSource.OUTBOUND
export const SCOPE = ResearchSource.SCOPE
export const HIDDEN = ResearchSource.HIDDEN
export const hidden = ResearchSource.hidden
export const shown = ResearchSource.shown

/**
 * Saves a page the run read and shows it, with the sites the user chose for this run. `tool` names who read it in the
 * fence; `signedIn` marks a page the user's own signed-in browser showed. `lead` says whether the agent reading is the
 * run's lead, who alone is shown a private source another read saved.
 */
export const keep = Effect.fnUntraced(function* (input: {
  readonly research: ResearchRun.Interface
  readonly store: ResearchStore.Interface
  readonly found: ResearchRun.Found
  readonly page: ResearchReader.Page
  readonly view: View
  readonly lead: boolean
  readonly tool?: string
  readonly signedIn?: boolean
}) {
  return yield* ResearchSource.keep({
    store: input.store,
    place: input.found.place,
    runID: input.found.run.id,
    // "You trust this site" is Vector's own word beside the fence, so only sites the user chose earn it, never ones a
    // plan approved on its own named.
    domains: yield* input.research.domains(input.found),
    page: input.page,
    view: input.view,
    lead: input.lead,
    ...(input.tool ? { tool: input.tool } : {}),
    ...(input.signedIn ? { signedIn: input.signedIn } : {}),
  })
})
