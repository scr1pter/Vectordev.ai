export function extractAssistantReply(value: unknown, depth = 0): string {
  if (!value || depth > 6) return ""
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) {
    return value
      .map((item) => extractAssistantReply(item, depth + 1))
      .filter(Boolean)
      .join("\n")
      .trim()
  }
  if (typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  if (record.type === "text" && typeof record.text === "string") return record.text.trim()
  if (Array.isArray(record.parts)) {
    const text = record.parts
      .filter((part) => typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text")
      .map((part) => extractAssistantReply(part, depth + 1))
      .filter(Boolean)
      .join("\n")
      .trim()
    if (text) return text
  }
  for (const key of ["text", "content", "message", "data", "response"]) {
    const text = extractAssistantReply(record[key], depth + 1)
    if (text) return text
  }
  return ""
}
