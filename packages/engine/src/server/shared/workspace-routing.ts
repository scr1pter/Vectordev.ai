import { SessionID } from "@/session/schema"
import { Option, Schema } from "effect"

type Rule = { method?: string; path: string; exact?: boolean; action: "local" | "forward" }

const RULES: Array<Rule> = [
  { path: "/experimental/workspace", action: "local" },
  { path: "/session/status", action: "forward" },
  { method: "GET", path: "/session", action: "local" },
]

export function isLocalWorkspaceRoute(method: string, path: string) {
  for (const rule of RULES) {
    if (rule.method && rule.method !== method) continue
    const match = rule.exact ? path === rule.path : path === rule.path || path.startsWith(rule.path + "/")
    if (match) return rule.action === "local"
  }
  return false
}

/** The session a request targets, from the matched route's params. */
export function getWorkspaceRouteSessionID(params: Readonly<Record<string, string | undefined>>) {
  // Route params are untrusted. Global SSE event IDs also use an `evt_`
  // prefix and one accidentally routed through this middleware in the desktop
  // app; calling the branded constructor turned that ordinary bad request into
  // a server defect that interrupted the active subagent. Only a decoded
  // session ID may participate in workspace lookup.
  const decoded = Schema.decodeUnknownOption(SessionID)(params.sessionID)
  return Option.isSome(decoded) ? decoded.value : null
}

export function workspaceProxyURL(target: string | URL, requestURL: URL) {
  const proxyURL = new URL(target)
  proxyURL.pathname = `${proxyURL.pathname.replace(/\/$/, "")}${requestURL.pathname}`
  proxyURL.search = requestURL.search
  proxyURL.hash = requestURL.hash
  proxyURL.searchParams.delete("workspace")
  return proxyURL
}
