import { ApiError, handleApiError, json, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { platformAdmin, platformUsageLimits, requireEntitlement } from "../_lib/platform.js"

type AgentUsageRow = {
  status: string
  token_usage: Record<string, unknown> | null
  cost_usd: number | string | null
}

type QuotaUsageRow = {
  kind: "cloud_agent_launch_30d" | "cloud_agent_turn_30d" | "api_execute_day"
  units: number | string | null
  created_at: string | null
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET for this endpoint.")
    const { user } = await requireEntitlement(request)
    const admin = platformAdmin()
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const [requests, runs, keys, tools, quotaEvents] = await Promise.all([
      admin
        .from("vector_api_history")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", since),
      admin
        .from("vector_agent_runs")
        .select("status,token_usage,cost_usd")
        .eq("user_id", user.id)
        .gte("created_at", since),
      admin
        .from("vector_api_keys")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .is("revoked_at", null),
      admin
        .from("vector_tool_connections")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("enabled", true),
      admin
        .from("vector_usage_events")
        .select("kind,units,created_at")
        .eq("user_id", user.id)
        .in("kind", ["cloud_agent_launch_30d", "cloud_agent_turn_30d", "api_execute_day"])
        .gte("created_at", since),
    ])
    if (requests.error || runs.error || keys.error || tools.error || quotaEvents.error) {
      throw new ApiError(500, "USAGE_LOAD_FAILED", "Vector could not load platform usage.")
    }
    const runRows = (runs.data || []) as AgentUsageRow[]
    const tokens = runRows.reduce((total, run) => {
      const usage = (run.token_usage || {}) as Record<string, unknown>
      return total + Object.values(usage).reduce<number>((sum, value) => sum + (Number(value) || 0), 0)
    }, 0)
    const cost = runRows.reduce((total, run) => total + (Number(run.cost_usd) || 0), 0)
    const quotaRows = (quotaEvents.data || []) as QuotaUsageRow[]
    const launchesUsed = quotaRows
      .filter((event) => event.kind === "cloud_agent_launch_30d")
      .reduce((total, event) => total + Number(event.units || 0), 0)
    const turnsUsed = quotaRows
      .filter((event) => event.kind === "cloud_agent_turn_30d")
      .reduce((total, event) => total + Number(event.units || 0), 0)
    const apiExecutionsToday = quotaRows
      .filter(
        (event) =>
          event.kind === "api_execute_day" && new Date(event.created_at || 0).getTime() >= Date.now() - 86_400_000,
      )
      .reduce((total, event) => total + Number(event.units || 0), 0)
    const limits = platformUsageLimits()
    json(response, 200, {
      periodDays: 30,
      apiRequests: requests.count || 0,
      cloudRuns: runRows.length,
      activeRuns: runRows.filter((run) => run.status === "running" || run.status === "starting").length,
      completedRuns: runRows.filter((run) => run.status === "complete").length,
      cloudTokens: tokens,
      cloudCostUsd: Math.round(cost * 1_000_000) / 1_000_000,
      activeApiKeys: keys.count || 0,
      connectedTools: tools.count || 0,
      cloudLaunchesUsed: launchesUsed,
      cloudTurnsUsed: turnsUsed,
      apiExecutionsToday,
      limits,
    })
  } catch (error) {
    handleApiError(response, error)
  }
}
