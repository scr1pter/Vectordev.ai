/**
 * What a memory tool call put in use on its own, for the session's "Learned: … · Undo" line, or nothing for a search,
 * a write held for review, a refusal or words memory already had. A personal entry's words stay out of the transcript,
 * and so do those of one learned from a private document (`private`), so either comes without text.
 */
export function memoryLearned(metadata: Record<string, unknown> | undefined) {
  const learned = metadata?.learned
  if (typeof metadata?.id !== "string" || !learned || typeof learned !== "object") return undefined
  return {
    id: metadata.id,
    text: "text" in learned && typeof learned.text === "string" ? learned.text : undefined,
    ...("private" in learned && learned.private === true ? { private: true } : {}),
  }
}
