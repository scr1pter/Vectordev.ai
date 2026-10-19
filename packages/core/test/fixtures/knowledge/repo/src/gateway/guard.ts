import * as sessions from "../auth/session"

export function guard(token: string) {
  return sessions.rotateRefreshToken(token)
}
