export const SESSION_FOLLOWUP_LIMIT = 20

export function enqueueSessionFollowup<T>(items: readonly T[] | undefined, item: T) {
  const current = items ?? []
  if (current.length >= SESSION_FOLLOWUP_LIMIT) return
  return [...current, item]
}
