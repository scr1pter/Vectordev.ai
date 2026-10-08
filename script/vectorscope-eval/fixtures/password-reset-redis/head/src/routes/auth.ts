import { Hono } from "hono"
import { consumePasswordReset, requestPasswordReset } from "../auth/password-reset"
import { hashPassword } from "../auth/passwords"
import type { AppEnv } from "../env"

export const authRoutes = new Hono<AppEnv>()

authRoutes.post("/password-reset", async (c) => {
  const body = await c.req.json<{ email?: unknown }>()
  if (typeof body.email !== "string" || !body.email.includes("@"))
    return c.json({ error: "Enter an email address" }, 400)
  await requestPasswordReset(c.var.db, c.var.redis, c.var.mailer, body.email)
  return c.json({ ok: true })
})

authRoutes.post("/password-reset/confirm", async (c) => {
  const body = await c.req.json<{ token?: unknown; password?: unknown }>()
  if (typeof body.token !== "string" || typeof body.password !== "string")
    return c.json({ error: "Missing token or password" }, 400)
  if (body.password.length < 12) return c.json({ error: "Use at least 12 characters" }, 400)
  const userId = await consumePasswordReset(c.var.redis, body.token)
  if (!userId) return c.json({ error: "This reset link has expired or was already used" }, 400)
  await c.var.db.users.update(userId, { passwordHash: await hashPassword(body.password) })
  // Anyone who had the old password, or a stolen session, is signed out everywhere.
  await c.var.sessions.revokeAll(userId)
  return c.json({ ok: true })
})
