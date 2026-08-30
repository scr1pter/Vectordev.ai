export type UpdaterDisabledReason = "not-packaged" | "development-channel" | "emergency-disabled"

export function updaterPolicy(input: {
  packaged: boolean
  channel: "dev" | "beta" | "prod"
  override?: string
}): { enabled: true } | { enabled: false; reason: UpdaterDisabledReason } {
  if (!input.packaged) return { enabled: false, reason: "not-packaged" }
  if (input.channel === "dev") return { enabled: false, reason: "development-channel" }
  const override = input.override?.trim().toLowerCase()
  if (override === "0" || override === "false" || override === "off") {
    return { enabled: false, reason: "emergency-disabled" }
  }
  return { enabled: true }
}

export function updaterEnabled(input: Parameters<typeof updaterPolicy>[0]) {
  return updaterPolicy(input).enabled
}
