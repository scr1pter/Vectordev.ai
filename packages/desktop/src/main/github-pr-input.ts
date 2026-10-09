import { isAbsolute } from "node:path"

const STATES = new Set(["open", "closed", "merged", "all"])
const REVIEW_EVENTS = new Set(["comment", "approve", "request-changes"])
const MERGE_STRATEGIES = new Set(["merge", "squash", "rebase"])
const DIFF_SIDES = new Set(["LEFT", "RIGHT"])
const MAX_REVIEW_COMMENTS = 60
const MAX_SECRETS = 8

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

export function requirePullRequestHead(value: unknown) {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) {
    throw new Error("Review requires the pull request's full commit SHA. Reload the pull request and review it again.")
  }
  return value.toLowerCase()
}

// Only the known fields are kept, so nothing else the renderer sends reaches GitHub.
export function requirePullRequestComments(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_REVIEW_COMMENTS) {
    throw new Error(`A review can carry at most ${MAX_REVIEW_COMMENTS} line comments.`)
  }
  return value.map((comment: unknown, index) => {
    const label = `Line comment ${index + 1}`
    if (typeof comment !== "object" || comment === null) throw new Error(`${label} is invalid.`)
    const raw = comment as { path?: unknown; line?: unknown; side?: unknown; startLine?: unknown; body?: unknown }
    const path = raw.path
    if (typeof path !== "string" || !path || path.length > 1_024 || path.includes("\0") || path.startsWith("/")) {
      throw new Error(`${label} needs a file path relative to the repository.`)
    }
    const line = requireDiffLine(raw.line, label)
    const startLine = raw.startLine === undefined ? undefined : requireDiffLine(raw.startLine, label)
    if (startLine !== undefined && startLine >= line) throw new Error(`${label} must start before the line it ends on.`)
    if (typeof raw.side !== "string" || !DIFF_SIDES.has(raw.side)) {
      throw new Error(`${label} side must be LEFT or RIGHT.`)
    }
    return {
      path,
      line,
      side: raw.side as "LEFT" | "RIGHT",
      startLine,
      body: requirePullRequestText(raw.body, `${label} body`, 65_536, false),
    }
  })
}

function requireDiffLine(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 10_000_000) {
    throw new Error(`${label} line numbers must be positive integers.`)
  }
  return value
}

export function requireMergeStrategy(value: unknown) {
  if (typeof value !== "string" || !MERGE_STRATEGIES.has(value)) throw new Error("Invalid pull request merge strategy.")
  return value as "merge" | "squash" | "rebase"
}

// The workflow writes the model unquoted as `MODEL: provider/model`, so only characters that keep it one plain YAML
// scalar are accepted: no spaces, quotes or #, and no trailing colon.
export function requireWorkflowModel(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._:/@+-]*[A-Za-z0-9._/@+-]$/.test(value)
  ) {
    throw new Error("The model for automatic reviews must be written as provider/model.")
  }
  const slash = value.indexOf("/")
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

// The environment variables a provider reads its key from. Each becomes a repository secret of the same name, which
// GitHub allows only without its own GITHUB_ prefix.
export function requireSecretNames(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length > MAX_SECRETS ||
    !value.every(
      (name) => typeof name === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(name) && !name.startsWith("GITHUB_"),
    )
  ) {
    throw new Error("Provider key names must be environment variable names, such as ANTHROPIC_API_KEY.")
  }
  return [...new Set(value as string[])]
}
