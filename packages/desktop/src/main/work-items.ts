import { execFile } from "node:child_process"
import { untrustedChildEnvironment } from "@opencode-ai/core/child-environment"
import { getStore } from "./store"
import {
  githubIssueToWorkItem,
  jiraIssueToWorkItem,
  linearIssueToWorkItem,
  sortWorkItems,
  workItemPrompt,
  type WorkItem,
  type WorkItemProvider,
} from "./work-items-model"

// Reading the trackers a team actually runs on, so a ticket becomes something
// an agent can be handed rather than something a person retypes into a prompt.
//
// GitHub goes through the user's own `gh`, which already holds their
// credentials and honours their org's SSO. Linear and Jira need a token, which
// is the user's to paste and is stored in Vector's own application data.

const STORE_NAME = "work-items-state"
const CONFIG_KEY = "providers"
const REQUEST_TIMEOUT_MS = 20_000

export type WorkItemsConfig = {
  linear?: { token: string }
  jira?: { site: string; email: string; token: string; jql?: string }
}

// The brief travels with the item so the renderer never re-implements it: the
// composer lives in work-items-model.ts, where it is unit tested.
export type WorkItemWithBrief = WorkItem & { brief: string }

export type WorkItemsResult = {
  items: WorkItemWithBrief[]
  // One entry per provider that could not be read, so a broken Jira token never
  // silently empties the board.
  problems: { provider: WorkItemProvider; message: string }[]
}

function readConfig(): WorkItemsConfig {
  const raw = getStore(STORE_NAME).get(CONFIG_KEY)
  return raw && typeof raw === "object" ? (raw as WorkItemsConfig) : {}
}

export function workItemsConfig(): { linear: boolean; jira: boolean; jiraSite?: string } {
  const config = readConfig()
  // Never returns the tokens themselves — the renderer only needs to know
  // whether a provider is set up.
  return { linear: Boolean(config.linear?.token), jira: Boolean(config.jira?.token), jiraSite: config.jira?.site }
}

export function saveWorkItemsConfig(next: WorkItemsConfig) {
  const current = readConfig()
  getStore(STORE_NAME).set(CONFIG_KEY, { ...current, ...next })
  return workItemsConfig()
}

export function clearWorkItemsProvider(provider: "linear" | "jira") {
  const current = readConfig()
  delete current[provider]
  getStore(STORE_NAME).set(CONFIG_KEY, current)
  return workItemsConfig()
}

function gh(args: string[], cwd?: string) {
  return new Promise<{ stdout: string; failed: boolean; stderr: string }>((resolve) => {
    execFile(
      "gh",
      args,
      { cwd, env: untrustedChildEnvironment(), timeout: REQUEST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: Boolean(error) }),
    )
  })
}

async function fetchJson(url: string, init: RequestInit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const response = await fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

async function githubItems(cwd: string) {
  const result = await gh(
    [
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      "50",
      "--json",
      "number,title,body,url,state,updatedAt,assignees,labels,comments",
    ],
    cwd,
  )
  if (result.failed) {
    const detail = result.stderr.trim().split("\n").at(-1) ?? "gh could not list issues."
    throw new Error(detail)
  }
  const parsed = JSON.parse(result.stdout || "[]") as Parameters<typeof githubIssueToWorkItem>[0][]
  return parsed.map(githubIssueToWorkItem)
}

async function linearItems(token: string) {
  // Only issues assigned to the token's own user: a whole workspace's backlog
  // is not a to-do list, and Vector is answering "what is mine".
  const query = `query {
    viewer {
      assignedIssues(first: 50, filter: { state: { type: { neq: "canceled" } } }) {
        nodes {
          id identifier title description url updatedAt
          state { name }
          assignee { name }
          labels { nodes { name } }
          comments { nodes { body user { name } } }
        }
      }
    }
  }`
  const body = (await fetchJson("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  })) as { data?: { viewer?: { assignedIssues?: { nodes?: Parameters<typeof linearIssueToWorkItem>[0][] } } } }
  return (body.data?.viewer?.assignedIssues?.nodes ?? []).map(linearIssueToWorkItem)
}

async function jiraItems(config: NonNullable<WorkItemsConfig["jira"]>) {
  const site = config.site.replace(/\/+$/, "")
  const jql = config.jql?.trim() || "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"
  const auth = Buffer.from(`${config.email}:${config.token}`).toString("base64")
  const body = (await fetchJson(`${site}/rest/api/2/search?maxResults=50&fields=*navigable,comment`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jql, maxResults: 50, fields: ["summary", "description", "status", "assignee", "labels", "updated", "comment"] }),
  })) as { issues?: Parameters<typeof jiraIssueToWorkItem>[0][] }
  return (body.issues ?? []).map((issue) => jiraIssueToWorkItem(issue, site))
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Every provider is read independently: one bad token must not take the board
// down with it, so failures come back as problems alongside whatever loaded.
export async function listWorkItems(cwd: string): Promise<WorkItemsResult> {
  const config = readConfig()
  const problems: WorkItemsResult["problems"] = []
  const results = await Promise.all([
    githubItems(cwd).catch((error: unknown) => {
      problems.push({ provider: "github", message: message(error) })
      return [] as WorkItem[]
    }),
    config.linear?.token
      ? linearItems(config.linear.token).catch((error: unknown) => {
          problems.push({ provider: "linear", message: message(error) })
          return [] as WorkItem[]
        })
      : Promise.resolve([] as WorkItem[]),
    config.jira?.token
      ? jiraItems(config.jira).catch((error: unknown) => {
          problems.push({ provider: "jira", message: message(error) })
          return [] as WorkItem[]
        })
      : Promise.resolve([] as WorkItem[]),
  ])
  const items = sortWorkItems(results.flat()).map((item) => ({ ...item, brief: workItemPrompt(item) }))
  return { items, problems }
}
