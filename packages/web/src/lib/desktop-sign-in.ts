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
    // The person already chose Continue, then signed in again (see deletionReauthPath).
    confirmed: purpose === "delete" && query.get("confirmed") === "1",
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
 * page, so a link alone cannot sign anyone out or send a confirmation; or go straight on when they chose it before
 * signing in again. Whether the sign-in is recent enough is the API's to say (deletionNeedsSignIn), so a browser clock
 * that is off never decides it.
 */
export function deletionConfirmation(continued: boolean, request: { confirmed?: boolean }) {
  return continued || request.confirmed ? ("send" as const) : ("ask" as const)
}

/** Whether vectordev.ai refused to confirm a deletion only because this browser's sign-in is not recent. */
export function deletionNeedsSignIn(status: number, payload: unknown) {
  const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined
  return (
    status === 401 &&
    Boolean(error && typeof error === "object" && "code" in error && error.code === "RECENT_SIGN_IN_REQUIRED")
  )
}

/**
 * Where to sign in again before confirming a deletion. The way back says the person already chose Continue, so they
 * are not asked twice; it counts only with the fresh sign-in, since the API checks that whatever the link says.
 */
export function deletionReauthPath(request: { returnPath: string }) {
  return `/login?${new URLSearchParams({ returnTo: `${request.returnPath}&confirmed=1`, reauth: "1" })}`
}
