export * as VectorAccount from "./vector-account"

import path from "node:path"
import { readFile } from "node:fs/promises"
import { Option, Schema } from "effect"
import { Global } from "./global"

const Stored = Schema.Struct({ token: Schema.String.check(Schema.isStartsWith("vct_")) })

/** CLI fallback only. Callers resolve an explicit environment token and the secure provider store first. */
export async function readVectorToken(file = path.join(Global.Path.data, "cli-auth.json")) {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw new Error(
      "Vector could not read its CLI account token. Repair the CLI data-file permissions or sign in again.",
    )
  })
  if (!text) return undefined
  const stored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored))(text)
  return Option.isSome(stored) ? stored.value.token : undefined
}

export async function resolveVectorToken(input: {
  environment?: string
  stored: () => Promise<string | undefined>
  fallback?: () => Promise<string | undefined>
}) {
  if (input.environment) return input.environment
  const stored = await input.stored()
  if (stored) return stored
  return (input.fallback ?? readVectorToken)()
}
