export * as ConfigResearchV1 from "./research"

import { Schema } from "effect"
import type { TaskSize } from "@vectordevai/schema/task-size"
import { NonNegativeInt, PositiveInt } from "../../schema"

// The `research` block: Deep research's settings. `search` is read from user or global config only, so a checked-in
// repository config cannot send the user's queries to a server its author runs; a repository may only add avoided
// domains.

const Strings = Schema.mutable(Schema.Array(Schema.String))

export const Provider = Schema.Literals(["auto", "searxng", "exa", "parallel", "browser", "none"]).annotate({
  identifier: "ResearchSearchProvider",
})
export type Provider = typeof Provider.Type

export const Depth = Schema.Literals(["auto", "focused", "deep"]).annotate({ identifier: "ResearchDepthConfig" })
export type Depth = typeof Depth.Type

// The smallest request size at which the build agent may run research as a tool on its own, besides the Deep
// research mode: "work" offers it on Work and Thorough requests, "thorough" on Thorough requests only, "off" never.
// A Chat-sized request never gets it.
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
  search: Schema.optional(
    Schema.Struct({
      provider: Schema.optional(Provider),
      url: Schema.optional(Schema.String).annotate({ description: "A SearXNG instance with its JSON format enabled" }),
    }),
  ).annotate({ description: "Where research searches go. Read from your user config only. Default: none set up." }),
  depth: Schema.optional(Depth).annotate({
    description: "Focused uses one agent; deep adds researchers (default: auto)",
  }),
  tool: Schema.optional(Tool).annotate({
    description:
      "When the build agent may research as a tool on its own requests: work (Work and Thorough requests), thorough (Thorough only) or off. Default: work.",
  }),
  limits: Schema.optional(Schema.Struct({ focused: Schema.optional(Limits), deep: Schema.optional(Limits) })).annotate({
    description: "Caps for one research run, used when you have no spend cap of your own",
  }),
  domains: Schema.optional(
    Schema.Struct({ prefer: Schema.optional(Strings), avoid: Schema.optional(Strings) }),
  ).annotate({ description: "Sites research prefers or avoids. A repository's config may only add to avoid." }),
  robots: Schema.optional(Schema.Boolean).annotate({
    description: "Respect robots.txt for links Vector finds itself (default: true)",
  }),
  browser_search: Schema.optional(Schema.Boolean).annotate({
    description: "Let the desktop app load a search engine's results page as a search provider (default: false)",
  }),
  retain_days: Schema.optional(PositiveInt).annotate({
    description: "Days an unkept research run stays in the brain (default: 30)",
  }),
}).annotate({ identifier: "ResearchConfig" })
export type Info = Schema.Schema.Type<typeof Info>

// Whether the build agent gets research as a tool on a request of this size. This is the seam the research tools
// read; the Deep research mode itself does not depend on it.
export function buildTool(tier: TaskSize.Tier, setting: Tool = "work") {
  if (tier === "chat" || setting === "off") return false
  return setting === "work" || tier === "thorough"
}
