import { dirname, resolve } from "node:path"

const STORE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function requireStoreName(value: unknown) {
  if (typeof value === "string" && STORE_NAME.test(value)) return value
  throw new Error("Invalid store name")
}

export function resolveStorePath(userData: string, name: unknown) {
  const root = resolve(userData)
  const file = resolve(root, requireStoreName(name))
  if (dirname(file) !== root) throw new Error("Invalid store name")
  return file
}
