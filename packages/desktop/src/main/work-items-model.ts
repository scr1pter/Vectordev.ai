// Work as it arrives from a tracker, normalised into one shape Vector can hand
// to an agent. Pure so the normalisation and the brief can be tested without a
// Jira instance, a Linear workspace or a network.

export type WorkItemProvider = "github" | "linear" | "jira"

export type WorkItem = {
  id: string
  provider: WorkItemProvider
  // What a human calls it: "VEC-2481", "#612".
  key: string
  title: string
  body: string
  url: string
  state: string
  // Normalised from each tracker's own vocabulary so the board can group them.
  status: "todo" | "in-progress" | "review" | "done"
  assignee?: string
  labels: string[]
  updatedAt: string
  comments: { author: string; text: string }[]
}

const DONE = ["done", "closed", "completed", "resolved", "merged", "shipped", "cancelled", "canceled"]
const REVIEW = ["review", "in review", "code review", "qa", "verifying", "testing"]
const PROGRESS = ["progress", "in progress", "doing", "started", "development", "wip"]

export function normalizeStatus(raw: string): WorkItem["status"] {
  const value = raw.trim().toLowerCase()
  if (DONE.some((item) => value.includes(item))) return "done"
  // Checked before "in progress": "in review" contains neither, but a tracker
  // that calls it "In Progress - Review" should land on review, not progress.
  if (REVIEW.some((item) => value.includes(item))) return "review"
  if (PROGRESS.some((item) => value.includes(item))) return "in-progress"
  return "todo"
}

function trimBody(body: string, limit = 4_000) {
  const value = body.trim()
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n\n… description truncated by Vector at ${limit} characters.`
}

export function githubIssueToWorkItem(raw: {
  number: number
  title: string
  body?: string | null
  url: string
  state: string
  updatedAt?: string
  assignees?: { login: string }[]
  labels?: { name: string }[]
  comments?: { author?: { login?: string } | null; body?: string }[]
}): WorkItem {
  return {
    id: `github:${raw.number}`,
    provider: "github",
    key: `#${raw.number}`,
    title: raw.title,
    body: trimBody(raw.body ?? ""),
    url: raw.url,
    state: raw.state,
    status: normalizeStatus(raw.state),
    assignee: raw.assignees?.[0]?.login,
    labels: (raw.labels ?? []).map((label) => label.name),
    updatedAt: raw.updatedAt ?? "",
    comments: (raw.comments ?? []).map((comment) => ({
      author: comment.author?.login ?? "someone",
      text: (comment.body ?? "").trim(),
    })),
  }
}

export function linearIssueToWorkItem(raw: {
  id: string
  identifier: string
  title: string
  description?: string | null
  url: string
  updatedAt?: string
  state?: { name?: string } | null
  assignee?: { name?: string } | null
  labels?: { nodes?: { name: string }[] } | null
  comments?: { nodes?: { user?: { name?: string } | null; body?: string }[] } | null
}): WorkItem {
  const state = raw.state?.name ?? "Todo"
  return {
    id: `linear:${raw.id}`,
    provider: "linear",
    key: raw.identifier,
    title: raw.title,
    body: trimBody(raw.description ?? ""),
    url: raw.url,
    state,
    status: normalizeStatus(state),
    assignee: raw.assignee?.name,
    labels: (raw.labels?.nodes ?? []).map((label) => label.name),
    updatedAt: raw.updatedAt ?? "",
    comments: (raw.comments?.nodes ?? []).map((comment) => ({
      author: comment.user?.name ?? "someone",
      text: (comment.body ?? "").trim(),
    })),
  }
}

export function jiraIssueToWorkItem(
  raw: {
    id: string
    key: string
    fields?: {
      summary?: string
      description?: string | null
      updated?: string
      status?: { name?: string } | null
      assignee?: { displayName?: string } | null
      labels?: string[]
      comment?: { comments?: { author?: { displayName?: string } | null; body?: string }[] } | null
    } | null
  },
  siteUrl: string,
): WorkItem {
  const fields = raw.fields ?? {}
  const state = fields.status?.name ?? "To Do"
  return {
    id: `jira:${raw.id}`,
    provider: "jira",
    key: raw.key,
    title: fields.summary ?? raw.key,
    body: trimBody(fields.description ?? ""),
    // Jira's REST payload has no browser URL on the issue, so it is built from
    // the site the token belongs to.
    url: `${siteUrl.replace(/\/+$/, "")}/browse/${raw.key}`,
    state,
    status: normalizeStatus(state),
    assignee: fields.assignee?.displayName,
    labels: fields.labels ?? [],
    updatedAt: fields.updated ?? "",
    comments: (fields.comment?.comments ?? []).map((comment) => ({
      author: comment.author?.displayName ?? "someone",
      text: (comment.body ?? "").trim(),
    })),
  }
}

// The brief an agent receives when a ticket is handed to it. The whole point of
// reading the tracker is that the agent gets what the ticket actually says —
// description, labels, and the comments where the real detail usually lives —
// rather than a title someone retyped into a prompt.
export function workItemPrompt(item: WorkItem) {
  // Trimmed here rather than trusting the normalisers: a whitespace-only
  // comment is truthy, and rendered as "- Sam:" with nothing after it.
  const comments = item.comments
    .map((comment) => ({ author: comment.author, text: comment.text.trim() }))
    .filter((comment) => comment.text)
    .slice(0, 8)
    .map((comment) => `- ${comment.author}: ${comment.text}`)
  return [
    `You are picking up ${item.key} from ${item.provider === "github" ? "GitHub" : item.provider === "linear" ? "Linear" : "Jira"}.`,
    "",
    `Title: ${item.title}`,
    item.labels.length ? `Labels: ${item.labels.join(", ")}` : "",
    item.url ? `Link: ${item.url}` : "",
    "",
    item.body ? `Description:\n${item.body}` : "The ticket has no description beyond its title.",
    comments.length ? `\nComments on the ticket:\n${comments.join("\n")}` : "",
    "",
    "Do the work this ticket describes. Read the repository before changing anything, make the smallest complete change that satisfies it, and run the project's own checks.",
    "If the ticket is ambiguous or asks for something the code contradicts, say so in your summary instead of guessing.",
    "Finish with what changed, what you ran, and anything still open.",
  ]
    .filter(Boolean)
    .join("\n")
}

// A short name for the workspace the ticket becomes, so the board reads as work
// rather than as a list of identifiers.
export function workItemWorkspaceName(item: WorkItem) {
  const title = item.title.trim()
  const short = title.length > 48 ? `${title.slice(0, 48).trimEnd()}…` : title
  return `${item.key} · ${short}`
}

export function sortWorkItems(items: readonly WorkItem[]) {
  const rank: Record<WorkItem["status"], number> = { "in-progress": 0, review: 1, todo: 2, done: 3 }
  return [...items].sort((a, b) => {
    const diff = rank[a.status] - rank[b.status]
    if (diff !== 0) return diff
    return Date.parse(b.updatedAt || "0") - Date.parse(a.updatedAt || "0")
  })
}
