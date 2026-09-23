import { Config, Effect, Option } from "effect"

const warned = new Set<string>()

export function warnLegacy(name: string, replacement: string) {
  if (warned.has(name)) return
  warned.add(name)
  console.warn(`[Vector] ${name} is deprecated; use ${replacement} instead.`)
}

/** Prefer Vector's environment names while keeping existing scripts working. */
export function readEnv(key: string) {
  if (!key.startsWith("OPENCODE_")) return process.env[key]
  const current = key.replace(/^OPENCODE_/, "VECTOR_")
  if (process.env[current] !== undefined) return process.env[current]
  if (process.env[key] !== undefined) warnLegacy(key, current)
  return process.env[key]
}

/** Preserve Effect ConfigProvider overrides as well as process environments. */
export function configEnv<A>(key: string, read: (name: string) => Config.Config<A>) {
  if (!key.startsWith("OPENCODE_")) return read(key)
  const current = key.replace(/^OPENCODE_/, "VECTOR_")
  return Config.make((provider) =>
    read(current)
      .pipe(Config.option)
      .parse(provider)
      .pipe(
        Effect.flatMap((value) =>
          Option.isSome(value)
            ? Effect.succeed(value.value)
            : read(key)
                .parse(provider)
                .pipe(Effect.tap(() => Effect.sync(() => warnLegacy(key, current)))),
        ),
      ),
  )
}
