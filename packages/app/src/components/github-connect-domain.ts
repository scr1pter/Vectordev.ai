// Pure helpers shared by the GitHub dialogs (push and clone).

export function relativeTime(iso?: string, now = Date.now()) {
  if (!iso) return undefined
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return undefined
  const minutes = Math.round((now - then) / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

export function filterGithubRepos<T extends { fullName: string }>(repos: T[], query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return repos
  return repos.filter((repo) => repo.fullName.toLowerCase().includes(needle))
}
