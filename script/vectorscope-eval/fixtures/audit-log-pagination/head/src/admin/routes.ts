import { Hono } from "hono"
import { requireAdmin } from "../auth/require-admin"
import type { AppEnv } from "../env"
import { DEFAULT_PAGE_SIZE, pageAuditEntries } from "./audit-log"

export const adminRoutes = new Hono<AppEnv>()

adminRoutes.use("*", requireAdmin)

adminRoutes.get("/audit", async (c) => {
  const page = Number(c.req.query("page") ?? "1")
  const pageSize = Number(c.req.query("pageSize") ?? DEFAULT_PAGE_SIZE)
  if (!Number.isInteger(page) || page < 1) return c.json({ error: "page must be a positive integer" }, 400)
  if (!Number.isInteger(pageSize)) return c.json({ error: "pageSize must be an integer" }, 400)
  const result = await pageAuditEntries(
    c.var.db,
    c.var.orgId,
    {
      actorId: c.req.query("actor") || undefined,
      action: c.req.query("action") || undefined,
    },
    page,
    pageSize,
  )
  return c.json(result)
})

adminRoutes.get("/members", async (c) => {
  const members = await c.var.db.members.findMany({ where: { orgId: c.var.orgId } })
  return c.json({ members })
})
