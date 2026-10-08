import { createHash, randomBytes } from "node:crypto"
import type { Redis } from "ioredis"
import type { Database } from "../db"
import type { Mailer } from "../mail"

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/ // 32 random bytes in base64url

// Reset tokens live in Redis instead of the passwordResets table. GETDEL makes a token single-use without a
// transaction, and Redis expires unused tokens, so the nightly purge of the table can go.
export async function requestPasswordReset(db: Database, redis: Redis, mailer: Mailer, email: string): Promise<void> {
  const user = await db.users.findByEmail(email.trim().toLowerCase())
  // Answer the same way whether or not the account exists, so the form cannot be used to find accounts.
  if (!user) return
  const token = randomBytes(32).toString("base64url")
  await redis.set(key(token), user.id, "EX", RESET_TOKEN_TTL_MS)
  await mailer.send(user.email, "reset-password", { token, minutes: RESET_TOKEN_TTL_MS / 60_000 })
}

export async function consumePasswordReset(redis: Redis, token: string): Promise<string | undefined> {
  if (!TOKEN_PATTERN.test(token)) return undefined
  const userId = await redis.getdel(key(token))
  return userId ?? undefined
}

// Only the hash is stored, so a Redis snapshot does not hand out working reset links.
function key(token: string) {
  return `password-reset:${createHash("sha256").update(token).digest("hex")}`
}
