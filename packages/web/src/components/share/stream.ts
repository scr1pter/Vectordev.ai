type ShareRecord = Record<string, unknown>

export type ShareStreamEvent =
  | { type: "info"; content: ShareRecord }
  | { type: "message"; messageID: string; content: ShareRecord }
  | { type: "part"; messageID: string; content: ShareRecord }

export function parseShareStreamEvent(value: unknown, sessionID: string): ShareStreamEvent | undefined {
  if (!isRecord(value) || typeof value.key !== "string" || !isRecord(value.content)) return

  const [root, type, keySessionID, messageID, partID, ...rest] = value.key.split("/")
  if (root !== "session" || keySessionID !== sessionID || rest.length) return

  if (type === "info") {
    if (messageID || partID || value.content.id !== sessionID) return
    return { type, content: value.content }
  }

  if (type === "message") {
    if (!messageID || partID || value.content.id !== messageID || !ownsSession(value.content, sessionID)) return
    if ("metadata" in value.content) return { type, messageID, content: value.content }
    if (!shareMessageBelongsToSession(value.content, sessionID, messageID)) return
    return { type, messageID, content: value.content }
  }

  if (type === "part") {
    if (!messageID || !partID || !sharePartBelongsToMessage(value.content, sessionID, messageID, partID)) return
    return { type, messageID, content: value.content }
  }
}

export function shareMessageBelongsToSession(value: unknown, sessionID: string, messageID: string) {
  if (!isRecord(value) || value.id !== messageID || value.sessionID !== sessionID) return false
  if (value.parts === undefined) return true
  if (!Array.isArray(value.parts)) return false
  return value.parts.every((part) => sharePartBelongsToMessage(part, sessionID, messageID))
}

function sharePartBelongsToMessage(value: unknown, sessionID: string, messageID: string, partID?: string) {
  if (!isRecord(value) || value.sessionID !== sessionID || value.messageID !== messageID) return false
  return partID === undefined || value.id === partID
}

function ownsSession(value: ShareRecord, sessionID: string) {
  const metadata = isRecord(value.metadata) ? value.metadata : undefined
  const ids = [value.sessionID, metadata?.sessionID].filter((id) => id !== undefined)
  return ids.length > 0 && ids.every((id) => id === sessionID)
}

function isRecord(value: unknown): value is ShareRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
