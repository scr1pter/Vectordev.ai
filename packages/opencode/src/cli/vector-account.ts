import fs from "fs/promises"
import path from "path"
import open from "open"
import { Global } from "@opencode-ai/core/global"
import { UI } from "./ui"

/**
 * Vector CLI account gate.
 *
 * The `vector` terminal agent is free, but requires a Vector account. Tokens
 * are minted at {site}/auth/cli after signing in and pasted into the CLI once;
 * they are verified against the Vector API and cached with an offline grace
 * window so flaky networks never lock anyone out of their own terminal.
 */

const AUTH_FILE = path.join(Global.Path.data, "cli-auth.json")
const SITE = (process.env.VECTOR_SITE_URL ?? "https://vectordev.ai").replace(/\/+$/, "")
const VERIFY_INTERVAL = 24 * 60 * 60 * 1000
const OFFLINE_GRACE = 7 * 24 * 60 * 60 * 1000

type CliUser = { id: string; email: string }
type StoredAuth = { token: string; user: CliUser; verifiedAt: number }

async function load(): Promise<StoredAuth | undefined> {
  const raw = await fs.readFile(AUTH_FILE, "utf8").catch(() => undefined)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (
      typeof parsed?.token === "string" &&
      typeof parsed?.user?.id === "string" &&
      typeof parsed?.user?.email === "string" &&
      typeof parsed?.verifiedAt === "number"
    )
      return parsed as StoredAuth
  } catch {
    // corrupt file falls through to a fresh login
  }
  return undefined
}

async function save(auth: StoredAuth) {
  await fs.mkdir(path.dirname(AUTH_FILE), { recursive: true })
  await fs.writeFile(AUTH_FILE, JSON.stringify(auth, undefined, 2), { mode: 0o600 })
}

export async function signOut() {
  await fs.rm(AUTH_FILE, { force: true })
}

export async function currentUser(): Promise<CliUser | undefined> {
  return (await load())?.user
}

type VerifyResult = { status: "ok"; user: CliUser } | { status: "invalid"; message?: string } | { status: "offline" }

// Only a definitive answer from the Vector API counts as a rejection. Captive
// portals, proxies, rate limits, and outages must never sign a user out.
const REJECTION_CODES = new Set(["CLI_TOKEN_INVALID", "CLI_TOKEN_EXPIRED"])

async function verifyToken(token: string): Promise<VerifyResult> {
  const response = await fetch(`${SITE}/api/account/cli-verify`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!response) return { status: "offline" }
  const payload = (await response.json().catch(() => undefined)) as
    | { ok?: boolean; user?: CliUser; error?: { code?: string; message?: string } }
    | undefined
  if (response.ok && payload?.ok && payload.user) return { status: "ok", user: payload.user }
  if (payload?.error?.code && REJECTION_CODES.has(payload.error.code))
    return { status: "invalid", message: payload.error.message }
  return { status: "offline" }
}

// Prompt on stderr so a piped stdout never receives prompt text.
function ask(prompt: string): Promise<string> {
  const readline = require("readline") as typeof import("readline")
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => rl.question(prompt, (answer: string) => (rl.close(), resolve(answer.trim()))))
}

export async function login(provided?: string): Promise<CliUser | undefined> {
  const url = `${SITE}/auth/cli`
  let token = provided?.trim() ?? ""
  if (!token) {
    UI.empty()
    UI.println(UI.Style.TEXT_NORMAL_BOLD + "Sign in to Vector")
    UI.println(UI.Style.TEXT_DIM + "The Vector agent is free — it just needs a Vector account.")
    UI.empty()
    UI.println("1. Your browser is opening " + UI.Style.TEXT_INFO_BOLD + url + UI.Style.TEXT_NORMAL)
    UI.println("2. Sign in (or create a free account) and copy the command it shows you")
    UI.println("3. Run that command — or paste just the token below")
    UI.empty()
    await open(url).catch(() => undefined)
    token = (await ask("CLI token: ")).trim()
  }
  if (!token) {
    UI.error("No token entered.")
    return undefined
  }
  if (!token.startsWith("vct_")) {
    UI.error(`That does not look like a Vector CLI token (they start with vct_). Get one at ${url}`)
    return undefined
  }
  const verified = await verifyToken(token)
  if (verified.status === "offline") {
    UI.error("Vector could not reach vectordev.ai to verify the token. Check your connection and try again.")
    return undefined
  }
  if (verified.status === "invalid") {
    UI.error(verified.message ?? `That token was not accepted. Generate a fresh one at ${url}`)
    return undefined
  }
  await save({ token, user: verified.user, verifiedAt: Date.now() })
  UI.empty()
  UI.println(UI.Style.TEXT_SUCCESS_BOLD + "✓ Signed in as " + verified.user.email)
  return verified.user
}

/**
 * Blocks agent commands until a Vector account is present. Returns quietly
 * when the session is already verified; exits the process when sign-in is
 * impossible (declined, invalid, or non-interactive without a token).
 */
export async function ensureVectorAccount(): Promise<void> {
  const envToken = process.env.VECTOR_CLI_TOKEN
  if (envToken) {
    const verified = await verifyToken(envToken)
    if (verified.status === "ok" || verified.status === "offline") return
    UI.error("VECTOR_CLI_TOKEN is not valid. Generate a new token at " + `${SITE}/auth/cli`)
    process.exit(1)
  }

  const stored = await load()
  if (stored) {
    const age = Date.now() - stored.verifiedAt
    if (age < VERIFY_INTERVAL) return
    const verified = await verifyToken(stored.token)
    if (verified.status === "ok") {
      await save({ token: stored.token, user: verified.user, verifiedAt: Date.now() })
      return
    }
    if (verified.status === "offline") {
      if (age < OFFLINE_GRACE) return
      UI.error("Vector could not verify your account and the offline grace period has passed. Reconnect and try again.")
      process.exit(1)
    }
    // token revoked or expired — fall through to a fresh login
    await signOut()
    UI.println(UI.Style.TEXT_WARNING_BOLD + "Your Vector session expired — sign in again.")
  }

  if (!process.stdin.isTTY) {
    UI.error(
      `A free Vector account is required. Run "vector login" in a terminal, or set VECTOR_CLI_TOKEN (create one at ${SITE}/auth/cli).`,
    )
    process.exit(1)
  }

  const user = await login()
  if (!user) process.exit(1)
}
