export function updaterEnabled(input: { packaged: boolean; channel: "dev" | "beta" | "prod"; override?: string }) {
  if (!input.packaged || input.channel === "dev") return false
  const override = input.override?.trim().toLowerCase()
  if (override === "0" || override === "false" || override === "off") return false
  return true
}
