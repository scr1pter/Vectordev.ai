export const MAX_LOGIN_ATTEMPTS = 5

const failures = new Map<string, number>()

export function recordFailure(account: string) {
  const count = (failures.get(account) ?? 0) + 1
  failures.set(account, count)
  return count >= MAX_LOGIN_ATTEMPTS
}
