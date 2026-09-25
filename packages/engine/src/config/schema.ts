export * as ConfigSchema from "./schema"

import { applyEdits, modify, parse } from "jsonc-parser"

export function rewrite(text: string, kind: "config" | "tui" | "theme" | "desktop-theme" = "config") {
  const data: unknown = parse(text)
  if (!data || typeof data !== "object" || Array.isArray(data)) return text
  const current = "$schema" in data ? data.$schema : undefined
  const url = typeof current === "string" && URL.canParse(current) ? new URL(current) : undefined
  const legacy =
    url && !["vectordev.ai", "www.vectordev.ai"].includes(url.hostname)
      ? url.pathname.match(/\/(config|tui|theme|desktop-theme)\.json$/)?.[1]
      : undefined
  if (current !== undefined && !legacy) return text
  return applyEdits(
    text,
    modify(text, ["$schema"], `https://vectordev.ai/${legacy ?? kind}.json`, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  )
}
