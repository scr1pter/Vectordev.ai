export * as UsageSummary from "./usage-summary.js"

import { Schema } from "effect"

// The owner's usage dashboard: aggregate counts only, never an account, install or content.
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))
const Share = Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })))
const Client = Schema.Literals(["desktop", "cli"])
const Label = Schema.String.check(Schema.isMaxLength(32))
const Money = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const Fraction = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Identifier = Schema.String.check(Schema.isMaxLength(120))

export const Totals = Schema.Struct({
  accounts: Count,
  installs: Count,
  cliAccounts: Count,
  downloads: Count,
  downloadAccounts: Count,
  activeToday: Count,
  active7: Count,
  previous7: Count,
  active30: Count,
  sessions7: Count,
  subagentSessions7: Count,
}).annotate({ identifier: "UsageSummary.Totals" })

export const Daily = Schema.Struct({
  day: Day,
  active: Count,
  desktop: Count,
  cli: Count,
  sessions: Count,
  subagentSessions: Count,
  // Model use on that calendar day as each install or CLI account reported it (local days).
  tokens: Count,
  cost: Money,
  tasks: Count,
}).annotate({ identifier: "UsageSummary.Daily" })
export type Daily = typeof Daily.Type

export const Weekly = Schema.Struct({
  week: Day,
  active: Count,
  desktop: Count,
  cli: Count,
  // Change from the previous week; null when that week had nobody to compare against.
  growth: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "UsageSummary.Weekly" })
export type Weekly = typeof Weekly.Type

export const Cohort = Schema.Struct({
  cohort: Day,
  size: Count,
  // Share of the cohort active again in weeks 1..4; null until that week has finished.
  weeks: Schema.Array(Share),
}).annotate({ identifier: "UsageSummary.Cohort" })
export type Cohort = typeof Cohort.Type

export const Funnel = Schema.Struct({
  week: Day,
  signups: Count,
  downloaded: Count,
  active: Count,
}).annotate({ identifier: "UsageSummary.Funnel" })
export type Funnel = typeof Funnel.Type

export const Version = Schema.Struct({ client: Client, version: Label, active: Count }).annotate({
  identifier: "UsageSummary.Version",
})
export const Platform = Schema.Struct({ client: Client, platform: Label, arch: Label, active: Count }).annotate({
  identifier: "UsageSummary.Platform",
})

// Model use across everyone, from the latest usage report of each install and CLI account (Settings > Usage & streaks).
export const Usage = Schema.Struct({
  // Installs and CLI accounts that have sent a usage report.
  reporting: Count,
  lifetimeTokens: Count,
  lifetimeCost: Money,
  inputTokens: Count,
  outputTokens: Count,
  reasoningTokens: Count,
  cachedTokens: Count,
  completedChats: Count,
  conversations: Count,
  modelResponses: Count,
  tokens7: Count,
  previousTokens7: Count,
  cost7: Money,
  previousCost7: Money,
  // Tokens in the last 7 days per weekly active person; null while nobody was active.
  tokensPerActive7: Schema.NullOr(Count),
}).annotate({ identifier: "UsageSummary.Usage" })
export type Usage = typeof Usage.Type

// Estimated from each install's five most-used models, by their latest lifetime tokens.
export const Model = Schema.Struct({
  providerID: Identifier,
  modelID: Identifier,
  tokens: Count,
  people: Count,
  // Share of the tokens of every listed model across everyone.
  share: Fraction,
}).annotate({ identifier: "UsageSummary.Model" })
export type Model = typeof Model.Type

export const Effort = Schema.Struct({
  id: Identifier,
  label: Identifier,
  tokens: Count,
  responses: Count,
  people: Count,
  share: Fraction,
}).annotate({ identifier: "UsageSummary.Effort" })
export type Effort = typeof Effort.Type

// People whose latest report (today or yesterday) shows a current streak of days in a row with a task.
export const Streaks = Schema.Struct({ one: Count, twoToSix: Count, sevenPlus: Count }).annotate({
  identifier: "UsageSummary.Streaks",
})
export type Streaks = typeof Streaks.Type

export const Summary = Schema.Struct({
  generatedAt: Schema.String.check(Schema.isMaxLength(40)),
  today: Day,
  totals: Totals,
  daily: Schema.Array(Daily).check(Schema.isMaxLength(400)),
  weekly: Schema.Array(Weekly).check(Schema.isMaxLength(60)),
  monthly: Schema.Array(Schema.Struct({ month: Day, active: Count })).check(Schema.isMaxLength(24)),
  retention: Schema.Array(Cohort).check(Schema.isMaxLength(60)),
  funnel: Schema.Array(Funnel).check(Schema.isMaxLength(60)),
  versions: Schema.Array(Version).check(Schema.isMaxLength(100)),
  platforms: Schema.Array(Platform).check(Schema.isMaxLength(100)),
  usage: Usage,
  models: Schema.Array(Model).check(Schema.isMaxLength(40)),
  efforts: Schema.Array(Effort).check(Schema.isMaxLength(40)),
  streaks: Streaks,
}).annotate({ identifier: "UsageSummary.Summary" })
export type Summary = typeof Summary.Type

// What a read-only share link (/usage#share=...) receives: the same aggregates, and when the link stops working.
export const Shared = Schema.Struct({
  shared: Schema.Struct({ expiresAt: Schema.String.check(Schema.isMaxLength(40)) }),
  summary: Summary,
}).annotate({ identifier: "UsageSummary.Shared" })
export type Shared = typeof Shared.Type

// A share link as the owner sees it. The link itself is shown once, when it is created; only its hash is stored.
export const Link = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  label: Schema.String.check(Schema.isMaxLength(80)),
  createdAt: Schema.String.check(Schema.isMaxLength(40)),
  expiresAt: Schema.String.check(Schema.isMaxLength(40)),
  revokedAt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(40))),
  lastViewedAt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(40))),
  views: Count,
  state: Schema.Literals(["active", "expired", "revoked"]),
}).annotate({ identifier: "UsageSummary.Link" })
export type Link = typeof Link.Type
