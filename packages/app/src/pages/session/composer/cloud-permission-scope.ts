import type { PermissionRequest } from "@vectordevai/sdk/v2"

// Vector Cloud asks before it publishes, changes a database or writes a host's
// environment, naming the provider, project and environment the action would
// touch. The metadata comes from the engine, so only non-empty strings show.
export function cloudPermissionScope(request: Pick<PermissionRequest, "permission" | "metadata">) {
  if (!request.permission.startsWith("vector_cloud_")) return
  const text = (key: string) => {
    const value = request.metadata[key]
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }
  const rows = [
    { label: "Provider", value: text("provider") },
    { label: "Project", value: text("project") },
    { label: "Environment", value: text("environment") },
  ].filter((row): row is { label: string; value: string } => Boolean(row.value))
  const summary = text("summary")
  if (!summary && !rows.length) return
  return { summary, rows }
}
