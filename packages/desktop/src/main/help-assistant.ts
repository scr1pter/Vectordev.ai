// The help assistant runs through the main process for the same reason bug
// reports do: the packaged renderer is served over a custom protocol and
// cannot reach vectordev.ai itself.
const API = (process.env.VECTOR_HELP_API_URL || "https://vectordev.ai/api/help").replace(/\/$/, "")

export type HelpTurn = { role: "user" | "assistant"; content: string }
export type HelpInput = { messages: HelpTurn[]; context: string }
export type HelpResult = { reply?: string; error?: string }

export async function askHelpAssistant(input: HelpInput): Promise<HelpResult> {
  const response = await fetch(`${API}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: input?.messages ?? [], context: input?.context ?? "" }),
  }).catch((cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))))

  if (response instanceof Error) {
    return { error: "Vector could not reach the help assistant. Check your connection." }
  }
  const body = (await response.json().catch(() => undefined)) as
    | { reply?: string; error?: { message?: string } }
    | undefined
  if (!response.ok) return { error: body?.error?.message ?? "The help assistant is unavailable right now." }
  if (!body?.reply) return { error: "The help assistant returned an empty response." }
  return { reply: body.reply }
}
