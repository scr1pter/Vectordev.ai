import { Option, Schema } from "effect"

export function desktopSignInRequest(search: string) {
  const query = new URLSearchParams(search)
  if (query.get("desktop") !== "1") return
  const state = query.get("state") ?? ""
  const challenge = query.get("code_challenge") ?? ""
  const purpose = query.get("purpose")
  if (
    query.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    (purpose !== null && purpose !== "delete")
  )
    throw new Error("Start sign-in from Vector to connect this desktop securely.")
  const destination = new URLSearchParams({
    desktop: "1",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Vector asks for this sign-in to confirm deleting the account; the API then needs a recent sign-in.
    ...(purpose === "delete" ? { purpose } : {}),
  })
  return {
    state,
    challenge,
    ...(purpose === "delete" ? { purpose: "delete" as const } : {}),
    returnPath: `/auth/cli?${destination}`,
  }
}

export function desktopSignInCallback(payload: Record<string, unknown>, state: string) {
  if (typeof payload.code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.code) || payload.state !== state)
    throw new Error("Vector could not prepare a secure sign-in link. Start sign-in again.")
  return `vector://auth/callback?${new URLSearchParams({ code: payload.code, state })}`
}

/**
 * What /auth/cli does when Vector asks to confirm deleting the account: wait until the person chooses Continue on the
 * page, so a link alone cannot sign anyone out or send a confirmation; then ask for a fresh sign-in if this one is
 * not recent; then send the confirmation back to Vector.
 */
export function deletionConfirmation(continued: boolean, accessToken: string, now = Date.now()) {
  if (!continued) return "ask" as const
  return signedInRecently(accessToken, now) ? ("confirm" as const) : ("sign-in-again" as const)
}

const SessionClaims = Schema.Struct({
  amr: Schema.Array(Schema.Struct({ method: Schema.String, timestamp: Schema.Number })),
})

/**
 * Whether this browser's sign-in is recent enough to confirm deleting the account. The API allows ten minutes; the
 * page asks for a fresh sign-in after five, so a slow clock or a slow page never sends someone a refusal instead.
 */
export function signedInRecently(accessToken: string, now = Date.now()) {
  const payload = accessToken.split(".")[1]
  const claims =
    payload && /^[A-Za-z0-9_-]+$/.test(payload) && payload.length % 4 !== 1
      ? Option.getOrUndefined(
          Schema.decodeUnknownOption(Schema.fromJsonString(SessionClaims))(
            new TextDecoder().decode(Uint8Array.from(atob(base64(payload)), (character) => character.charCodeAt(0))),
          ),
        )
      : undefined
  const latest = Math.max(0, ...(claims?.amr ?? []).map((entry) => entry.timestamp))
  return now - latest * 1000 < 5 * 60 * 1000
}

// JWT segments are base64url without padding; atob reads standard base64.
function base64(value: string) {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/")
  return standard + "=".repeat((4 - (standard.length % 4)) % 4)
}
