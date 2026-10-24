export * as ConfigResearchV1 from "./research"

import { Schema } from "effect"
import type { TaskSize } from "@vectordevai/schema/task-size"
import { NonNegativeInt, PositiveInt } from "../../schema"

// The `research` block: Deep research's settings. They are read from user, global and managed config only, so a
// checked-in repository config can neither clear host names from the outbound check with preferred domains, nor raise
// the caps or turn robots.txt off. A repository may only add domains to avoid and turn the build agent's research tool
// down (the engine's projectExecutableConfig).
//
// Research searches the web in each research agent's own browser, so there is no search setting. A config file from an
// earlier version may still hold `search` (a search service and its address) or `browser_search`: they load, and are
// ignored.

const Strings = Schema.mutable(Schema.Array(Schema.String))

export const Depth = Schema.Literals(["auto", "focused", "deep"]).annotate({ identifier: "ResearchDepthConfig" })
export type Depth = typeof Depth.Type

// The smallest request size at which the build agent may run research as a tool on its own, besides the Deep
// research mode: "work" offers it on Work and Thorough requests, "thorough" on Thorough requests only, "off" never.
// A Chat or Light request never gets it: Light is a small action done directly, without subagents.
export const Tool = Schema.Literals(["work", "thorough", "off"]).annotate({ identifier: "ResearchToolConfig" })
export type Tool = typeof Tool.Type

export const Limits = Schema.Struct({
  usd: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  steps: Schema.optional(PositiveInt),
  pages: Schema.optional(PositiveInt),
  searches: Schema.optional(NonNegativeInt),
  researchers: Schema.optional(NonNegativeInt.check(Schema.isLessThanOrEqualTo(4))),
}).annotate({ identifier: "ResearchLimitsConfig" })
export type Limits = Schema.Schema.Type<typeof Limits>

export const Info = Schema.Struct({
  depth: Schema.optional(Depth).annotate({
    description:
      "Focused: one agent, plus up to 2 researchers when the question has independent parts. Deep: up to 4 researchers and a citation judge (default: auto)",
  }),
  tool: Schema.optional(Tool).annotate({
    description:
      "When the build agent may research as a tool on its own requests: work (Work and Thorough requests), thorough (Thorough only) or off. Default: work. A repository's config may only turn it down.",
  }),
  limits: Schema.optional(Schema.Struct({ focused: Schema.optional(Limits), deep: Schema.optional(Limits) })).annotate({
    description:
      "Caps for one research run, used when you have no spend cap of your own. Read from your user config only.",
  }),
  domains: Schema.optional(
    Schema.Struct({ prefer: Schema.optional(Strings), avoid: Schema.optional(Strings) }),
  ).annotate({ description: "Sites research prefers or avoids. A repository's config may only add to avoid." }),
  robots: Schema.optional(Schema.Boolean).annotate({
    description: "Respect robots.txt for links Vector finds itself (default: true). Read from your user config only.",
  }),
  retain_days: Schema.optional(PositiveInt).annotate({
    description: "Days an unkept research run stays in the brain (default: 30)",
  }),
}).annotate({ identifier: "ResearchConfig" })
export type Info = Schema.Schema.Type<typeof Info>

// Whether the build agent gets research as a tool on a request of this size. This is the seam the research tools
// read; the Deep research mode itself does not depend on it.
export function buildTool(tier: TaskSize.Tier, setting: Tool = "work") {
  if (setting === "off") return false
  return tier === "thorough" || (setting === "work" && tier === "standard")
}
