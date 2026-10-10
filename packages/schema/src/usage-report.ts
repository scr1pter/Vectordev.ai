export * as UsageReport from "./usage-report.js"

import { Option, Schema } from "effect"

// The model-use totals the desktop app and the CLI add to their usage check-in: the numbers behind Settings > Usage &
// streaks, never prompts, code, file names, model output or keys. The server validates exactly this shape, and the SQL in
// docs/vector/owner-actions/sql/usage.sql repeats the same bounds.

// Far above what one computer uses, and low enough that a forged report cannot swamp everyone's totals. Many reports
// still add up past 2^53, so the summary reads its sums as plain numbers (usage-summary.ts).
const MAX_TOKENS = 1e12
const MAX_COST = 1e9
const MAX_COUNT = 1e9
const MAX_DAY_TOKENS = 1e10
const MAX_DAY_TASKS = 1e6
const MAX_DAY_COST = 1e6
const MAX_DAYS = 100_000
const MAX_DURATION = 1e12
const Tokens = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_TOKENS }))
const Cost = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: MAX_COST }))
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_COUNT }))
const Days = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_DAYS }))
const Duration = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_DURATION }))
const Percentage = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
const MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,120}$/
const EFFORT_ID = /^[A-Za-z0-9._:/@+-]{1,40}$/
const EFFORT_LABEL = /^[A-Za-z0-9._:/@+ -]{1,40}$/
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** A calendar day as YYYY-MM-DD; impossible dates such as 2026-02-30 are refused. */
export const CalendarDay = Schema.String.check(
  Schema.isPattern(ISO_DAY),
  Schema.makeFilter((value: string) => isCalendarDay(value)),
)

export const Day = Schema.Struct({
  date: CalendarDay,
  tokens: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_DAY_TOKENS })),
  tasks: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_DAY_TASKS })),
  cost: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: MAX_DAY_COST })),
}).annotate({ identifier: "UsageReport.Day" })
export type Day = typeof Day.Type

export const Model = Schema.Struct({
  providerID: Schema.String.check(Schema.isPattern(MODEL_ID)),
  modelID: Schema.String.check(Schema.isPattern(MODEL_ID)),
  tokens: Tokens,
  percentage: Percentage,
}).annotate({ identifier: "UsageReport.Model" })
export type Model = typeof Model.Type

export const Effort = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(EFFORT_ID)),
  label: Schema.String.check(Schema.isPattern(EFFORT_LABEL)),
  tokens: Tokens,
  responses: Count,
  percentage: Percentage,
}).annotate({ identifier: "UsageReport.Effort" })
export type Effort = typeof Effort.Type

export const Report = Schema.Struct({
  lifetimeTokens: Tokens,
  lifetimeCost: Cost,
  inputTokens: Tokens,
  outputTokens: Tokens,
  reasoningTokens: Tokens,
  cachedTokens: Tokens,
  completedChats: Count,
  conversations: Count,
  activeDays: Days,
  currentStreak: Days,
  longestStreak: Days,
  averageTaskMs: Duration,
  longestTaskMs: Duration,
  modelResponses: Count,
  // The last seven days with any use, as the local summary lists them (local calendar days).
  days: Schema.Array(Day).check(
    Schema.isMaxLength(8),
    Schema.makeFilter((days: ReadonlyArray<Day>) => distinct(days.map((day) => day.date))),
  ),
  favoriteModels: Schema.Array(Model).check(
    Schema.isMaxLength(10),
    Schema.makeFilter((models: ReadonlyArray<Model>) =>
      distinct(models.map((model) => `${model.providerID}\n${model.modelID}`)),
    ),
  ),
  effortLevels: Schema.Array(Effort).check(
    Schema.isMaxLength(10),
    Schema.makeFilter((efforts: ReadonlyArray<Effort>) => distinct(efforts.map((effort) => effort.id))),
  ),
}).annotate({ identifier: "UsageReport.Report" })
export type Report = typeof Report.Type

export const decode = Schema.decodeUnknownOption(Report, { onExcessProperty: "error" })

// The engine's local summary (GET /experimental/session/usage), read loosely: only these fields are taken from it.
const Summary = Schema.Struct({
  lifetimeTokens: Schema.Number,
  lifetimeCost: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  reasoningTokens: Schema.Number,
  cachedTokens: Schema.Number,
  completedChats: Schema.Number,
  conversations: Schema.Number,
  activeDays: Schema.Number,
  currentStreak: Schema.Number,
  longestStreak: Schema.Number,
  averageTaskMs: Schema.Number,
  longestTaskMs: Schema.Number,
  modelResponses: Schema.Number,
  days: Schema.Array(
    Schema.Struct({ date: Schema.String, tokens: Schema.Number, tasks: Schema.Number, cost: Schema.Number }),
  ),
  favoriteModels: Schema.Array(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      tokens: Schema.Number,
      percentage: Schema.Number,
    }),
  ),
  effortLevels: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      tokens: Schema.Number,
      responses: Schema.Number,
      percentage: Schema.Number,
    }),
  ),
})

/**
 * Builds the report from the engine's local usage summary. Numbers are clamped into range, entries the server would
 * refuse (an unusual custom model or effort name) are left out rather than failing the whole check-in, and only the last
 * seven days and the top five models are kept. Undefined when the input is not a usage summary (the engine lists each
 * day, model and effort once, so a repeated one means something else answered).
 */
export function fromSummary(input: unknown) {
  const summary = Option.getOrUndefined(Schema.decodeUnknownOption(Summary)(input))
  if (!summary) return undefined
  return Option.getOrUndefined(
    decode({
      lifetimeTokens: whole(summary.lifetimeTokens, MAX_TOKENS),
      lifetimeCost: money(summary.lifetimeCost, MAX_COST),
      inputTokens: whole(summary.inputTokens, MAX_TOKENS),
      outputTokens: whole(summary.outputTokens, MAX_TOKENS),
      reasoningTokens: whole(summary.reasoningTokens, MAX_TOKENS),
      cachedTokens: whole(summary.cachedTokens, MAX_TOKENS),
      completedChats: whole(summary.completedChats, MAX_COUNT),
      conversations: whole(summary.conversations, MAX_COUNT),
      activeDays: whole(summary.activeDays, MAX_DAYS),
      currentStreak: whole(summary.currentStreak, MAX_DAYS),
      longestStreak: whole(summary.longestStreak, MAX_DAYS),
      averageTaskMs: whole(summary.averageTaskMs, MAX_DURATION),
      longestTaskMs: whole(summary.longestTaskMs, MAX_DURATION),
      modelResponses: whole(summary.modelResponses, MAX_COUNT),
      days: summary.days
        .filter((day) => isCalendarDay(day.date))
        .slice(-7)
        .map((day) => ({
          date: day.date,
          tokens: whole(day.tokens, MAX_DAY_TOKENS),
          tasks: whole(day.tasks, MAX_DAY_TASKS),
          cost: money(day.cost, MAX_DAY_COST),
        })),
      favoriteModels: summary.favoriteModels
        .filter((model) => MODEL_ID.test(model.providerID) && MODEL_ID.test(model.modelID))
        .slice(0, 5)
        .map((model) => ({
          providerID: model.providerID,
          modelID: model.modelID,
          tokens: whole(model.tokens, MAX_TOKENS),
          percentage: percentage(model.percentage),
        })),
      effortLevels: summary.effortLevels
        .filter((effort) => EFFORT_ID.test(effort.id) && EFFORT_LABEL.test(effort.label))
        .slice(0, 10)
        .map((effort) => ({
          id: effort.id,
          label: effort.label,
          tokens: whole(effort.tokens, MAX_TOKENS),
          responses: whole(effort.responses, MAX_COUNT),
          percentage: percentage(effort.percentage),
        })),
    }),
  )
}

function isCalendarDay(value: string) {
  if (!ISO_DAY.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function distinct(values: ReadonlyArray<string>) {
  return new Set(values).size === values.length
}

function whole(value: number, maximum: number) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.round(value))) : 0
}

function money(value: number, maximum: number) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.round(value * 1e6) / 1e6)) : 0
}

function percentage(value: number) {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value * 10) / 10)) : 0
}
