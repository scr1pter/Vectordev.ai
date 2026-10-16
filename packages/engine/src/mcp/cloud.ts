export * as McpCloud from "./cloud"

import type { ConfigMCPV1 } from "@vectordevai/core/v1/config/mcp"

// Vercel's and Supabase's own MCP servers act on the same accounts as
// vector_cloud, on the login the server holds. Their tools ask under their own
// tool name, which the default allow rule answers, so without this a deploy, a
// SQL query or a billed project creation would run with no prompt. A tool that
// only lists or reads settings, logs or docs asks as other MCP tools do. Every
// other tool, including any the server adds later, also asks under the
// vector_cloud permission for that work, every time (PermissionPolicy).

export type Provider = "Vercel" | "Supabase"

export type Request = {
  permission: "vector_cloud_publish" | "vector_cloud_environment" | "vector_cloud_hosting" | "vector_cloud_database"
  provider: Provider
  /** The MCP server's name in the config. */
  server: string
  /** The tool's own name on that server. */
  tool: string
}

const HOSTS: Record<string, Provider> = {
  "mcp.vercel.com": "Vercel",
  "mcp.supabase.com": "Supabase",
}
const SUPABASE_PACKAGE = /^@supabase\/mcp-server-supabase(@|$)/

/** The provider whose own MCP server this entry connects to, if any. */
export function provider(entry: ConfigMCPV1.Info): Provider | undefined {
  if (entry.type === "remote") return host(entry.url)
  // A local server runs the Supabase package, or bridges to a hosted server (`npx mcp-remote https://mcp.vercel.com`).
  return entry.command
    .map((part): Provider | undefined => (SUPABASE_PACKAGE.test(part) ? "Supabase" : host(part)))
    .find((item) => item !== undefined)
}

function host(text: string) {
  if (!URL.canParse(text)) return
  return HOSTS[new URL(text).hostname.toLowerCase()]
}

// Tools that only list or read. A name that mentions keys, secrets, tokens,
// access or variables is never read as one: those can return credentials.
const READ = /^(list|get|search)_/
const CREDENTIAL = /key|secret|token|password|credential|bypass|access|env/
const SUPABASE_READS = new Set(["query_logs", "generate_typescript_types"])

/** The vector_cloud permission a provider server's tool asks under, or undefined for a plain read. */
export function request(provider: Provider, server: string, tool: string): Request | undefined {
  const name = tool.toLowerCase()
  if (!CREDENTIAL.test(name) && (READ.test(name) || (provider === "Supabase" && SUPABASE_READS.has(name)))) return
  return { permission: permission(provider, name), provider, server, tool }
}

function permission(provider: Provider, name: string): Request["permission"] {
  if (provider === "Supabase") return "vector_cloud_database"
  if (name.includes("env")) return "vector_cloud_environment"
  if (/deploy|promote|rollback|alias|release/.test(name)) return "vector_cloud_publish"
  return "vector_cloud_hosting"
}
