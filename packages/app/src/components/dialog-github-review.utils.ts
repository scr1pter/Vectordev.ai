export function normalizePullRequestReference(value: string) {
  const trimmed = value.trim()
  if (/^#\d+$/.test(trimmed)) return trimmed.slice(1)
  return trimmed
}

export function isPullRequestReference(value: string) {
  const normalized = normalizePullRequestReference(value)
  return (
    /^\d+$/.test(normalized) ||
    /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+(?:[/?#][^\s]*)?$/i.test(normalized)
  )
}
