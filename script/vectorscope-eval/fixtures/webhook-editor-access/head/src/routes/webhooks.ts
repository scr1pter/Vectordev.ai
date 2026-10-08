import { Hono } from "hono"
import { requireAdmin, requireRole } from "../auth/roles"
import type { AppEnv } from "../env"
import { createWebhook, deleteWebhook, listWebhooks, WEBHOOK_EVENTS } from "../webhooks/store"

export const webhookRoutes = new Hono<AppEnv>()

webhookRoutes.get("/", async (c) => {
  requireRole(c.var.member, "editor")
  return c.json({ webhooks: await listWebhooks(c.var.db, c.var.workspaceId) })
})

webhookRoutes.post("/", async (c) => {
  requireRole(c.var.member, "editor")
  const body = await c.req.json<{ url?: unknown; events?: unknown }>()
  if (typeof body.url !== "string" || !isHttpsUrl(body.url))
    return c.json({ error: "Webhook URLs must start with https://" }, 400)
  const events = Array.isArray(body.events) ? body.events.filter((event) => WEBHOOK_EVENTS.includes(event)) : []
  if (events.length === 0) return c.json({ error: "Pick at least one event" }, 400)
  const webhook = await createWebhook(c.var.db, c.var.workspaceId, { url: body.url, events })
  return c.json({ webhook }, 201)
})

// Deleting stays admin-only: other integrations may depend on a webhook its creator no longer needs.
webhookRoutes.delete("/:id", async (c) => {
  requireAdmin(c.var.member)
  await deleteWebhook(c.var.db, c.var.workspaceId, c.req.param("id"))
  return c.body(null, 204)
})

function isHttpsUrl(value: string) {
  return URL.canParse(value) && new URL(value).protocol === "https:"
}
