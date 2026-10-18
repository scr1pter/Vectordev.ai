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
    { label: projectLabel(text("provider")), value: text("project") },
    { label: "Environment", value: text("environment") },
  ].filter((row): row is { label: string; value: string } => Boolean(row.value))
  const summary = text("summary")
  if (!summary && !rows.length) return
  return { summary, rows }
}

// For Vector's own actions (stored variables, the local .env) the named project is the repository; for Vercel
// and Supabase it is the provider's project, so the label says whose it is.
function projectLabel(provider: string | undefined) {
  if (provider === "Vector") return "Repository"
  return `${provider ?? "Cloud"} project`
}

// The SQL a prompt is about: a query, a migration and its down file, or the
// down SQL a rollback runs. The engine sends it cut to a readable length with
// the full length beside it, for any permission (a new migration asks under
// edit). Entries that are not this shape are dropped.
export function permissionStatements(request: Pick<PermissionRequest, "metadata">) {
  const raw = request.metadata.statements
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return []
    const label = Reflect.get(item, "label")
    const sql = Reflect.get(item, "sql")
    const length = Reflect.get(item, "length")
    if (typeof label !== "string" || typeof sql !== "string" || !sql.trim()) return []
    const total = typeof length === "number" && length > sql.length ? length : sql.length
    return [
      {
        label,
        sql,
        note:
          total > sql.length
            ? `Showing the first ${sql.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters.`
            : undefined,
      },
    ]
  })
}
