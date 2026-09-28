import { formatUsd } from "@/features/economics/format-spend"
import type { SpendEvent, SpendLimitSet, SpendSummary } from "@/features/economics/spend-limits-api"

export type LimitKey = keyof SpendLimitSet

export const LIMIT_FIELDS: readonly { key: LimitKey; label: string }[] = [
  { key: "perRun", label: "Per run" },
  { key: "perDay", label: "Per day" },
  { key: "perMonth", label: "Per month" },
  { key: "perProjectMonth", label: "Per project per month" },
]

// A blank field clears the limit. Anything else must be a positive dollar amount.
export function parseUsd(text: string) {
  const trimmed = text.replace(/[$,\s]/g, "")
  if (!trimmed) return { ok: true as const, usd: undefined }
  const usd = Number(trimmed)
  if (!Number.isFinite(usd) || usd <= 0) return { ok: false as const }
  return { ok: true as const, usd }
}

// Warn at is typed as a percentage of each cap and stored as a fraction.
export function parseWarnAt(text: string) {
  const trimmed = text.replace(/[%\s]/g, "")
  if (!trimmed) return { ok: true as const, warnAt: undefined }
  const percent = Number(trimmed)
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return { ok: false as const }
  return { ok: true as const, warnAt: percent / 100 }
}

export function withLimit(set: SpendLimitSet, key: LimitKey, usd: number | undefined): SpendLimitSet {
  if (usd === undefined) return Object.fromEntries(Object.entries(set).filter((entry) => entry[0] !== key))
  const warnAt = columnWarnAt(set)
  return { ...set, [key]: warnAt === undefined ? { usd } : { usd, warnAt } }
}

// One Warn at per column, applied to every cap in it.
export function withWarnAt(set: SpendLimitSet, warnAt: number | undefined): SpendLimitSet {
  return Object.fromEntries(
    Object.entries(set).flatMap((entry) =>
      entry[1] ? [[entry[0], warnAt === undefined ? { usd: entry[1].usd } : { usd: entry[1].usd, warnAt }]] : [],
    ),
  )
}

export function columnWarnAt(set: SpendLimitSet) {
  return LIMIT_FIELDS.map((field) => set[field.key]?.warnAt).find((value) => value !== undefined)
}

export function summaryLine(summary: Pick<SpendSummary, "all">) {
  const unmeasured = summary.all.month.unmeasuredRuns
  return [
    `Today: ${formatUsd(summary.all.day.costUsd)}`,
    `This month: ${formatUsd(summary.all.month.costUsd)}`,
    ...(unmeasured > 0 ? [`${unmeasured} ${unmeasured === 1 ? "run" : "runs"} unmeasured`] : []),
  ].join(" · ")
}

const SOURCE_LABEL: Record<SpendEvent["source"], string> = {
  session: "Chat",
  parallel: "Parallel agent",
  scheduled: "Automation",
}

export function recentRunMeta(event: SpendEvent) {
  return [
    event.costUsd === undefined ? "unmeasured" : formatUsd(event.costUsd),
    SOURCE_LABEL[event.source],
    new Date(event.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
  ].join(" · ")
}
