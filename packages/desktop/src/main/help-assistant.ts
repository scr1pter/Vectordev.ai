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
    | { reply?: string; error?: { code?: string; message?: string } }
    | undefined
  if (!response.ok) {
    // The service's own words are written for whoever operates it, not for the
    // person typing a question. "Request protection is temporarily
    // unavailable" tells a user nothing they can act on, so the two cases they
    // can actually do something about are named here instead.
    if (response.status === 429) {
      return { error: "You've asked the help assistant a lot in a short window. Wait a minute and try again." }
    }
    if (body?.error?.code === "ABUSE_PROTECTION_UNAVAILABLE") {
      return {
        error:
          "Vector's help service is not accepting questions right now — this is an outage on our side, not something wrong with your setup. Email krishnabharadwaj0521@gmail.com and we'll answer directly.",
      }
    }
    return { error: body?.error?.message ?? "The help assistant is unavailable right now." }
  }
  if (!body?.reply) return { error: "The help assistant returned an empty response." }
  return { reply: body.reply }
}
