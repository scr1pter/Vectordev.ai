export * as UsageSummary from "./usage-summary.js"

import { Schema } from "effect"

// The owner's usage dashboard: aggregate counts only, never an account, install or content.
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))
const Share = Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })))
const Client = Schema.Literals(["desktop", "cli"])
const Label = Schema.String.check(Schema.isMaxLength(32))

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
}).annotate({ identifier: "UsageSummary.Summary" })
export type Summary = typeof Summary.Type
