export type CloudEnvironmentVariableLike = {
  key: string
  value: string
}

export function vercelEnvironmentPayload(variables: CloudEnvironmentVariableLike[]) {
  return variables.map((variable) => ({
    key: variable.key,
    value: variable.value,
    type: "encrypted" as const,
    target: ["production", "preview", "development"] as const,
    comment: "Synced by Vector",
  }))
}

export function netlifyEnvironmentPayload(variables: CloudEnvironmentVariableLike[]) {
  return variables.map((variable) => ({
    key: variable.key,
    scopes: ["builds", "functions", "runtime"] as const,
    values: [{ value: variable.value, context: "all" as const }],
    is_secret: true,
  }))
}

export function addNetlifyDomainAlias(aliases: string[], domain: string): string[] {
  const normalized = domain.toLowerCase()
  return [...new Set([...aliases.filter(Boolean), normalized])]
}

export function removeNetlifyDomainAlias(aliases: string[], domain: string): string[] {
  const normalized = domain.toLowerCase()
  return aliases.filter((alias) => alias.toLowerCase() !== normalized)
}
