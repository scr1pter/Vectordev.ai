// Vecbot commands in comments (section 2.4). /vecbot is the name; /vector and /vx
// still work, because they are written into workflows people already installed. The route script embeds `parseReviewCommand.toString()`, so that
// function must stay self-contained: no imports, no module-level values and no helpers outside its own body.

export type ReviewCommandKind = "review" | "review-full" | "pause" | "resume" | "dismiss" | "task" | "none"

export const DEFAULT_MENTIONS = ["/vecbot", "/vector", "/vx"]

export function parseReviewCommand(body: string, mentions: string[]): { kind: ReviewCommandKind } {
  const names = mentions
    .map((mention) => String(mention).trim().toLowerCase())
    .filter((mention) => mention.length > 0)
    .sort((a, b) => b.length - a.length)
  if (names.length === 0) return { kind: "none" }
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")

  // Quoted lines, code fences and HTML comments never count, so quoting, showing or hiding a command does not run it.
  const lines: string[] = []
  let fence = ""
  for (const raw of String(body ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    const line = raw.trim()
    const marker = /^(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const closes =
        !!marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        line.slice(marker[1].length).trim() === ""
      if (closes) fence = ""
      continue
    }
    if (marker) {
      fence = marker[1]
      continue
    }
    if (line.startsWith(">")) continue
    lines.push(line.toLowerCase())
  }

  // Only the first line that starts with a mention is read.
  const first = lines.find((line) => names.some((name) => line.startsWith(name)))
  if (first !== undefined) {
    // Trailing punctuation or invisible characters after a verb do not make it a task: "/vector review." reviews.
    const line = first.replace(/[\s.!?,;:\u00ad\u200b-\u200f\u2060-\u2064\ufeff]+$/, "")
    const verb = (rest: string) => new RegExp("^(?:" + alternatives + ")" + rest).test(line)
    if (verb("\\s+review\\s*$")) return { kind: "review" }
    if (verb("\\s+review\\s+full\\s*$")) return { kind: "review-full" }
    if (verb("\\s+pause\\s*$")) return { kind: "pause" }
    if (verb("\\s+resume\\s*$")) return { kind: "resume" }
    if (verb("\\s+dismiss\\b")) return { kind: "dismiss" }
    return { kind: "task" }
  }
  // The rule from before reviews: a body that starts with a mention, or has one after a space, is a task.
  const text = lines.join("\n")
  if (names.some((name) => text.startsWith(name) || text.includes(" " + name))) return { kind: "task" }
  return { kind: "none" }
}
