import { store } from "./store"

export const refreshTokenTtl = (days: number) => days * 86_400

export function rotateRefreshToken(previous: string) {
  store.delete(previous)
  const next = crypto.randomUUID()
  store.set(next, previous)
  return next
}
