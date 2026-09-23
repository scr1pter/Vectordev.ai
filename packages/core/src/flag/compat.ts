import { Config } from "effect"

/** Read the requested Vector or standard environment variable directly. */
export function readEnv(key: string) {
  return process.env[key]
}

/** Preserve Effect ConfigProvider overrides as well as process environments. */
export function configEnv<A>(key: string, read: (name: string) => Config.Config<A>) {
  return read(key)
}
