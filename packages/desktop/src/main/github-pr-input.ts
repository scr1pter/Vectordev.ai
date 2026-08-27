import { isAbsolute } from "node:path"

const STATES = new Set(["open", "closed", "merged", "all"])
const REVIEW_EVENTS = new Set(["comment", "approve", "request-changes"])
const MERGE_STRATEGIES = new Set(["merge", "squash", "rebase"])

export function requirePullRequestDirectory(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 4_096 || !isAbsolute(value)) {
    throw new Error("Pull request actions require an absolute project path.")
  }
  return value
}

export function requirePullRequestNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Pull request number must be a positive integer.")
  }
  return value
}

export function requirePullRequestState(value: unknown) {
  if (typeof value !== "string" || !STATES.has(value)) throw new Error("Invalid pull request state.")
  return value as "open" | "closed" | "merged" | "all"
}

export function requirePullRequestLimit(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new Error("Pull request limit must be between 1 and 500.")
  }
  return value
}

export function requirePullRequestText(value: unknown, label: string, maximum: number, empty = true) {
  if (typeof value !== "string" || value.length > maximum || (!empty && !value.trim())) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

export function requireReviewEvent(value: unknown) {
  if (typeof value !== "string" || !REVIEW_EVENTS.has(value)) throw new Error("Invalid pull request review action.")
  return value as "comment" | "approve" | "request-changes"
}

export function requireMergeStrategy(value: unknown) {
  if (typeof value !== "string" || !MERGE_STRATEGIES.has(value)) throw new Error("Invalid pull request merge strategy.")
  return value as "merge" | "squash" | "rebase"
}
