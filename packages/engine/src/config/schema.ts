export * as ConfigSchema from "./schema"

import { applyEdits, modify, parse } from "jsonc-parser"

export function rewrite(text: string, kind: "config" | "tui" = "config") {
  const data: unknown = parse(text)
  if (!data || typeof data !== "object" || Array.isArray(data)) return text
  const current = "$schema" in data ? data.$schema : undefined
  if (current !== undefined) return text
  return applyEdits(
    text,
    modify(text, ["$schema"], `https://vectordev.ai/${kind}.json`, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  )
}
