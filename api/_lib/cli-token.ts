import { createHmac, timingSafeEqual } from "node:crypto"
import { ApiError } from "./http.js"

/**
 * Vector CLI tokens (`vct_…`): stateless HMAC-signed grants minted for a
 * signed-in Vector account so the free terminal agent can verify "this
 * machine belongs to an account" without holding a Supabase session.
 * Format: vct_<base64url payload>.<base64url hmac-sha256>.
 */

export type CliTokenUser = { id: string; email: string }

const CLI_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

function secret() {
  // Prefer a dedicated secret; otherwise derive a purpose-bound key so this
  // system never shares raw key material with license/download signing.
  const dedicated = process.env.VECTOR_CLI_TOKEN_SECRET ?? ""
  if (dedicated.length >= 32) return dedicated
  const base = process.env.VECTOR_LICENSE_SECRET ?? ""
  if (base.length < 32) throw new ApiError(503, "CLI_TOKENS_UNAVAILABLE", "Vector CLI tokens are not configured.")
  return createHmac("sha256", base).update("vector-cli-token-key-v1").digest("base64url")
}

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url")

function sign(payload: string) {
  return createHmac("sha256", secret()).update(`vector-cli-v1.${payload}`).digest("base64url")
}

export function mintCliToken(user: CliTokenUser, now = Date.now()) {
  const expiresAt = now + CLI_TOKEN_TTL_MS
  const payload = encode(JSON.stringify({ v: 1, sub: user.id, email: user.email, exp: expiresAt }))
  return { token: `vct_${payload}.${sign(payload)}`, expiresAt }
}

export function verifyCliToken(token: string, now = Date.now()): CliTokenUser {
  const invalid = new ApiError(401, "CLI_TOKEN_INVALID", "That CLI token is not valid. Generate a new one.")
  if (typeof token !== "string" || !token.startsWith("vct_")) throw invalid
  const [payload, signature] = token.slice("vct_".length).split(".")
  if (!payload || !signature) throw invalid
  const expected = Buffer.from(sign(payload))
  const provided = Buffer.from(signature)
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw invalid
  let parsed: { v?: number; sub?: string; email?: string; exp?: number }
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    throw invalid
  }
  if (parsed.v !== 1 || typeof parsed.sub !== "string" || typeof parsed.email !== "string") throw invalid
  if (typeof parsed.exp !== "number" || parsed.exp <= now)
    throw new ApiError(401, "CLI_TOKEN_EXPIRED", "That CLI token has expired. Generate a new one.")
  return { id: parsed.sub, email: parsed.email }
}
