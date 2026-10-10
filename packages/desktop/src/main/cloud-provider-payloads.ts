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
