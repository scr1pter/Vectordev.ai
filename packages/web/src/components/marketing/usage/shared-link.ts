import { Option, Schema } from "effect"
import { UsageSummary } from "@vectordevai/schema/usage-summary"
import { readAccountApiResponse } from "../../../lib/account-client"

// A read-only share link is /usage#share=<token>. The fragment never reaches a server or a referrer;
// the token travels only to the summary API, in this header.
const SHARE_HEADER = "x-vector-usage-share"
const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/
const decodeShared = Schema.decodeUnknownOption(UsageSummary.Shared)

export type SharedView =
  | { kind: "ready"; summary: UsageSummary.Summary; shared: { expiresAt: string } }
  | { kind: "closed"; title: string; message: string }

/** The share token in an address fragment, or null when the address is not a share link. */
export function shareTokenFrom(hash: string) {
  return new URLSearchParams(hash.replace(/^#/, "")).get("share")
}

/** Reads the aggregates a share link may see. Rejects only when the numbers could not load at all. */
export async function readShared(token: string, fetcher: typeof fetch = fetch): Promise<SharedView> {
  if (!SHARE_TOKEN.test(token)) return closed(undefined)
  const response = await fetcher("/api/usage/summary", {
    headers: { accept: "application/json", [SHARE_HEADER]: token },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  })
  if (response.status === 404 || response.status === 410) {
    const payload = await response.json().catch(() => undefined)
    return closed(payload?.error?.code)
  }
  const shared = Option.getOrUndefined(decodeShared(await readAccountApiResponse(response, "Usage could not load.")))
  if (!shared) throw new Error("Usage could not load.")
  return { kind: "ready", summary: shared.summary, shared: shared.shared }
}

function closed(code: unknown): SharedView {
  if (code === "SHARE_EXPIRED")
    return { kind: "closed", title: "This link has expired", message: "Ask the person who shared it for a new one." }
  if (code === "SHARE_REVOKED")
    return {
      kind: "closed",
      title: "This link was turned off",
      message: "Its owner turned it off. Ask them for a new one if you still need it.",
    }
  return {
    kind: "closed",
    title: "This link isn't valid",
    message: "Check that the whole link was copied, or ask the person who shared it for a new one.",
  }
}
