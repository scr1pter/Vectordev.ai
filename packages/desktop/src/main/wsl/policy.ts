import type { WslDistroProbe, WslVectorCheck, WslServerItem } from "../../preload/types"

export function wslServerIdToRestart(servers: WslServerItem[], distro: string) {
  return servers.find((item) => item.config.distro === distro)?.config.id
}

export function clearWslDistroState(
  distroProbes: Record<string, WslDistroProbe>,
  vectorChecks: Record<string, WslVectorCheck>,
  distro: string,
) {
  const nextDistroProbes = { ...distroProbes }
  const nextVectorChecks = { ...vectorChecks }
  delete nextDistroProbes[distro]
  delete nextVectorChecks[distro]
  return { distroProbes: nextDistroProbes, vectorChecks: nextVectorChecks }
}

export function wslTerminalArgs(distro?: string | null) {
  return distro ? ["-d", distro] : []
}

const WSL_DISTRO = /^[A-Za-z0-9](?:[A-Za-z0-9._ -]{0,62}[A-Za-z0-9._-])?$/

export function isWslDistroName(value: unknown): value is string {
  return typeof value === "string" && WSL_DISTRO.test(value)
}

export function requireWslDistro(value: unknown, allowed: readonly string[]) {
  if (isWslDistroName(value) && allowed.includes(value)) return value
  throw new Error("Invalid or unavailable WSL distro")
}

export function requireWslDistros(value: unknown, allowed: readonly string[]) {
  if (!Array.isArray(value)) throw new Error("Invalid WSL distro")
  const values = value.map((item) => requireWslDistro(item, allowed))
  if (values.length > 0) return values
  throw new Error("Invalid WSL distro")
}

export function requireWslServerId(value: unknown, allowed: readonly string[]) {
  if (typeof value === "string" && allowed.includes(value)) return value
  throw new Error("Invalid or unavailable WSL server")
}
