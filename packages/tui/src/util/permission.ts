import { PermissionPolicy } from "@vectordevai/schema/permission-policy"

export const canAutoApprovePermission = PermissionPolicy.canAutoApprove
export const canAlwaysAllowPermission = PermissionPolicy.canAlwaysApprove

export function cloudPermissionDetails(request: { permission: string; metadata: Record<string, unknown> }) {
  if (!request.permission.startsWith("vector_cloud_")) return
  const text = (key: string) => {
    const value = request.metadata[key]
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }
  const rows = [
    { label: "Provider", value: text("provider") },
    {
      label: text("provider") === "Vector" ? "Repository" : `${text("provider") ?? "Cloud"} project`,
      value: text("project"),
    },
    { label: "Environment", value: text("environment") },
  ].flatMap((row) => (row.value ? [{ label: row.label, value: row.value }] : []))
  const statements = Array.isArray(request.metadata.statements)
    ? request.metadata.statements.flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return []
        const label = Reflect.get(item, "label")
        const sql = Reflect.get(item, "sql")
        const length = Reflect.get(item, "length")
        if (typeof label !== "string" || typeof sql !== "string" || !sql.trim()) return []
        return [{ label, sql, incomplete: typeof length === "number" && length > sql.length }]
      })
    : []
  return { summary: text("summary"), rows, statements }
}
