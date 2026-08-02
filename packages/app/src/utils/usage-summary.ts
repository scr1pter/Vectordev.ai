import type { SessionUsageSummary } from "@opencode-ai/sdk/v2"

export type UsageStreakDay = {
  date: string
  label: string
  day: string
  tokens: number
  active: boolean
  today: boolean
}

const localDateKey = (date: Date) => {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  const day = `${date.getDate()}`.padStart(2, "0")
  return `${year}-${month}-${day}`
}

const addDays = (date: Date, days: number) => {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

export function usageStreakCalendar(summary: SessionUsageSummary) {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const byDate = new Map(summary.days.map((day) => [day.date, day]))
  return Array.from({ length: 7 }, (_, index): UsageStreakDay => {
    const current = addDays(today, index - 6)
    const date = localDateKey(current)
    const usage = byDate.get(date)
    return {
      date,
      label: current.toLocaleDateString(undefined, { weekday: "short" }),
      day: current.toLocaleDateString(undefined, { day: "numeric" }),
      tokens: usage?.tokens ?? 0,
      active: (usage?.tasks ?? 0) > 0,
      today: index === 6,
    }
  })
}

function emptyUsageSummary(): SessionUsageSummary {
  return {
    lifetimeTokens: 0,
    lifetimeCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    peakTokens: 0,
    longestTaskMs: 0,
    longestTaskTokens: 0,
    averageTaskMs: 0,
    currentStreak: 0,
    longestStreak: 0,
    completedChats: 0,
    conversations: 0,
    activeDays: 0,
    averageTokensPerChat: 0,
    modelResponses: 0,
    favoriteModels: [],
    effortLevels: [],
    days: [],
  }
}

export function normalizeUsageSummary(value: Partial<SessionUsageSummary> | undefined): SessionUsageSummary {
  const fallback = emptyUsageSummary()
  return {
    ...fallback,
    ...value,
    favoriteModels: Array.isArray(value?.favoriteModels) ? value.favoriteModels : fallback.favoriteModels,
    effortLevels: Array.isArray(value?.effortLevels) ? value.effortLevels : fallback.effortLevels,
    days: Array.isArray(value?.days) ? value.days : fallback.days,
  }
}
