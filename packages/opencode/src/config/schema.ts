export * as ConfigSchema from "./schema"

import { applyEdits, modify, parse } from "jsonc-parser"

export function rewrite(text: string, kind: "config" | "tui" = "config") {
  const data: unknown = parse(text)
  if (!data || typeof data !== "object" || Array.isArray(data)) return text
  const current = "$schema" in data ? data.$schema : undefined
  // Exact legacy schema values are migration inputs only, never network destinations.
  const legacy = kind === "config" ? "https://opencode.ai/config.json" : "https://opencode.ai/tui.json"
  if (current !== undefined && current !== legacy) return text
  return applyEdits(
    text,
    modify(text, ["$schema"], `https://vectordev.ai/${kind}.json`, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  )
}
