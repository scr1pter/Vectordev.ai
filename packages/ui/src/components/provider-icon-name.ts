export const GENERIC_PROVIDER_ICON = "generic-provider"

export function providerIconName(id: string, names: readonly string[]) {
  return names.includes(id) ? id : GENERIC_PROVIDER_ICON
}
