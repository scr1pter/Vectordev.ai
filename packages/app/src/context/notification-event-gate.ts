export function createNotificationEventGate(limit = 500) {
  const seen = new Set<string>()

  return (id?: string) => {
    if (!id) return true
    if (seen.has(id)) return false

    seen.add(id)
    if (seen.size <= limit) return true

    const oldest = seen.values().next().value
    if (oldest) seen.delete(oldest)
    return true
  }
}
