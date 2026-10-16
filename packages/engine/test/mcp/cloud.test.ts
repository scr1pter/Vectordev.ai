import { describe, expect, test } from "bun:test"
import { McpCloud } from "../../src/mcp/cloud"

describe("Vercel and Supabase MCP servers", () => {
  test("recognises the providers' own servers, hosted or run locally", () => {
    expect(McpCloud.provider({ type: "remote", url: "https://mcp.vercel.com" })).toBe("Vercel")
    expect(McpCloud.provider({ type: "remote", url: "https://mcp.vercel.com/team-a/shop" })).toBe("Vercel")
    expect(McpCloud.provider({ type: "remote", url: "https://mcp.supabase.com/mcp?read_only=true" })).toBe("Supabase")
    expect(
      McpCloud.provider({
        type: "local",
        command: ["npx", "-y", "@supabase/mcp-server-supabase@latest", "--read-only"],
      }),
    ).toBe("Supabase")
    expect(McpCloud.provider({ type: "local", command: ["npx", "mcp-remote", "https://mcp.vercel.com"] })).toBe(
      "Vercel",
    )
    expect(McpCloud.provider({ type: "remote", url: "https://mcp.render.com/mcp" })).toBeUndefined()
    expect(McpCloud.provider({ type: "local", command: ["npx", "-y", "@railway/mcp-server"] })).toBeUndefined()
  })

  test("Supabase tools that change the project, run SQL or return keys ask under database", () => {
    for (const tool of [
      "execute_sql",
      "apply_migration",
      "deploy_edge_function",
      "create_edge_function_secret",
      "create_project",
      "confirm_cost",
      "pause_project",
      "restore_project",
      "merge_branch",
      "update_storage_config",
      "get_publishable_keys",
      "a_tool_added_later",
    ]) {
      expect({ tool, request: McpCloud.request("Supabase", "supabase", tool) }).toEqual({
        tool,
        request: { permission: "vector_cloud_database", provider: "Supabase", server: "supabase", tool },
      })
    }
    for (const tool of [
      "list_tables",
      "list_migrations",
      "get_project",
      "get_cost",
      "get_advisors",
      "query_logs",
      "search_docs",
      "generate_typescript_types",
    ]) {
      expect({ tool, request: McpCloud.request("Supabase", "supabase", tool) }).toEqual({ tool, request: undefined })
    }
  })

  test("Vercel tools ask under the permission for the work they do", () => {
    const cases = [
      ["deploy_to_vercel", "vector_cloud_publish"],
      ["promote_deployment", "vector_cloud_publish"],
      ["create_project_env", "vector_cloud_environment"],
      ["get_project_env", "vector_cloud_environment"],
      ["add_project_domain", "vector_cloud_hosting"],
      ["get_access_to_vercel_url", "vector_cloud_hosting"],
      ["web_fetch_vercel_url", "vector_cloud_hosting"],
    ] as const
    for (const [tool, permission] of cases) {
      expect({ tool, permission: McpCloud.request("Vercel", "vercel", tool)?.permission }).toEqual({ tool, permission })
    }
    for (const tool of ["list_deployments", "get_deployment", "get_runtime_logs", "list_teams", "list_projects"]) {
      expect({ tool, request: McpCloud.request("Vercel", "vercel", tool) }).toEqual({ tool, request: undefined })
    }
  })
})
