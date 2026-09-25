export function desktopSignInRequest(search: string) {
  const query = new URLSearchParams(search)
  if (query.get("desktop") !== "1") return
  const state = query.get("state") ?? ""
  const challenge = query.get("code_challenge") ?? ""
  if (
    query.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge)
  )
    throw new Error("Start sign-in from Vector to connect this desktop securely.")
  const destination = new URLSearchParams({
    desktop: "1",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  return { state, challenge, returnPath: `/auth/cli?${destination}` }
}

export function desktopSignInCallback(payload: Record<string, unknown>, state: string) {
  if (typeof payload.code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.code) || payload.state !== state)
    throw new Error("Vector could not prepare a secure sign-in link. Start sign-in again.")
  return `vector://auth/callback?${new URLSearchParams({ code: payload.code, state })}`
}
