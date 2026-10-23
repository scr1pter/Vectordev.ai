import { displaySlice } from "./display"

export function stripPromptPartIDs<Part extends { id: string; messageID: string; sessionID: string }>(part: Part) {
  const { id: _id, messageID: _messageID, sessionID: _sessionID, ...rest } = part
  return rest
}

export function expandPastedTextPlaceholders(text: string, parts: readonly unknown[]) {
  return parts.reduce<string>((result, part) => {
    if (!isPastedTextPart(part)) return result
    return result.replace(part.source.text.value, part.text)
  }, text)
}

function isPastedTextPart(part: unknown): part is { type: "text"; text: string; source: { text: { value: string } } } {
  if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return false
  if (!("text" in part) || typeof part.text !== "string" || !("source" in part)) return false
  const source = part.source
  if (!source || typeof source !== "object" || !("text" in source)) return false
  const text = source.text
  return Boolean(text && typeof text === "object" && "value" in text && typeof text.value === "string")
}

export function expandTrackedPastedText(text: string, ranges: { start: number; end: number; text: string }[]) {
  return expandPastedText(text, ranges).text
}

/**
 * The prompt's text with each tracked paste's placeholder replaced by what was pasted, and the spans of the result the
 * user pasted rather than typed, as `[start, end]` string offsets: those pastes, and pastes inserted as they were
 * (`inline`). Offsets in are the prompt's display offsets, as its extmarks keep them. The spans go with the sent part,
 * so Vector never learns what the user likes from what they pasted.
 */
export function expandPastedText(
  text: string,
  tracked: readonly { start: number; end: number; text: string }[],
  inline: readonly { start: number; end: number }[] = [],
) {
  const marks = [...tracked, ...inline.map((mark) => ({ ...mark, text: undefined }))].toSorted(
    (a, b) => a.start - b.start,
  )
  const out = marks.reduce(
    (acc, mark) => {
      // A mark inside one already read was read with it.
      if (mark.start < acc.at) return acc
      const before = acc.text + displaySlice(text, acc.at, mark.start)
      const pasted = mark.text ?? displaySlice(text, mark.start, mark.end)
      return {
        at: mark.end,
        text: before + pasted,
        pasted: pasted
          ? [...acc.pasted, [before.length, before.length + pasted.length] as [number, number]]
          : acc.pasted,
      }
    },
    { at: 0, text: "", pasted: [] as [number, number][] },
  )
  return { text: out.text + displaySlice(text, out.at), pasted: out.pasted }
}
