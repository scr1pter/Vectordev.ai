// Preserve accurate upstream provider names while normalizing casing and fallbacks.

const PROVIDER_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  "opencode-zen": "OpenCode Zen",
}

export function brandProviderName(id: string, name?: string | null): string {
  const value = (name ?? "").trim()
  if (value) return value
  return PROVIDER_LABELS[id] ?? id
}

export function brandProviderDescription(id: string): string | undefined {
  if (id === "opencode" || id === "opencode-zen")
    return "Free starter models — chat instantly, no API key or signup required."
  if (id === "opencode-go") return "OpenCode Go models, available inside Vector."
  return undefined
}
