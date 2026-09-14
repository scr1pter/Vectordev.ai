const LARGE_PASTE_CHARS = 8000
const LARGE_PASTE_BREAKS = 120

function largePaste(text: string) {
  if (text.length >= LARGE_PASTE_CHARS) return true
  let breaks = 0
  for (const char of text) {
    if (char !== "\n") continue
    breaks += 1
    if (breaks >= LARGE_PASTE_BREAKS) return true
  }
  return false
}

export function normalizePaste(text: string) {
  if (!text.includes("\r")) return text
  return text.replace(/\r\n?/g, "\n")
}

/**
 * The text a paste carries beside its files, or "" when that text only points at those files:
 * file managers put the copied files' names, paths or file URLs in the plain text, and those
 * should not land in the prompt next to the attachments.
 */
export function pasteCaption(text: string, files: readonly { name: string }[], types: readonly string[] = []) {
  if (types.includes("text/uri-list")) return ""
  const names = new Set(files.map((file) => file.name).filter(Boolean))
  const pointsAtFile = (line: string) => /^file:\/\//i.test(line) || names.has(line.split(/[\\/]/).at(-1) ?? "")
  const lines = normalizePaste(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.every(pointsAtFile) ? "" : text
}

export function pasteMode(text: string) {
  if (largePaste(text)) return "manual"
  if (text.includes("\n") || text.includes("\r")) return "manual"
  return "native"
}
