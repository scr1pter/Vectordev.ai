import { ApiError, handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

// Groq proxy for the Vector Help AI assistant. The key stays server-side so the
// desktop bundle never ships it. Requests are capped and the model is pinned
// here rather than taken from the client, so a leaked endpoint cannot be turned
// into a general-purpose inference gateway.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
const GROQ_KEY = process.env.GROQ_API_KEY || "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"
const MODEL = process.env.GROQ_HELP_MODEL || "llama-3.3-70b-versatile"
const MAX_TURNS = 24
const MAX_CHARS = 6_000
const MAX_CONTEXT_CHARS = 24_000
const MAX_OUTPUT_TOKENS = 1_024

// The assistant is grounded: the app ships the documentation corpus that the
// Help panel renders and sends the matching sections with each question. An
// ungrounded model invents buttons and menu paths that do not exist, which is
// worse than no assistant at all, so answering outside the supplied docs is
// forbidden here rather than merely discouraged.
const SYSTEM_PROMPT = `You are the Vector Help AI Assistant, built into the Vector desktop app.

Vector is a local-first AI engineering workspace. You help users understand and operate Vector itself.

You will be given DOCUMENTATION sections from Vector's own help corpus. That documentation is your ONLY source of truth about what Vector can do and where its controls live.

Hard rules:
- Answer strictly from the supplied DOCUMENTATION. Never rely on memory of other tools or on what seems plausible for an app like this.
- NEVER invent a button, panel, menu path, sidebar item, keyboard shortcut, or setting. If the documentation does not name a specific control, describe the capability without naming a control.
- If the documentation does not cover the question, say plainly that it is not covered and suggest the closest thing that is documented. Do not guess.
- Only discuss Vector. For anything unrelated, say you only cover Vector.
- Never ask for or repeat API keys, tokens, or passwords.
- Be concise and concrete. Plain prose and short lists, no headings.`

type ChatTurn = { role: "user" | "assistant"; content: string }

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    if (!GROQ_KEY) throw new ApiError(503, "HELP_NOT_CONFIGURED", "The Vector help assistant is not configured.")

    const body = await readJson<{ messages?: ChatTurn[]; context?: string }>(request, 96_000)
    const documentation = String(body.context ?? "").slice(0, MAX_CONTEXT_CHARS).trim()
    const turns = (Array.isArray(body.messages) ? body.messages : [])
      .filter((turn) => turn && (turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string")
      .slice(-MAX_TURNS)
      .map((turn) => ({ role: turn.role, content: turn.content.slice(0, MAX_CHARS) }))
    if (!turns.length) throw new ApiError(400, "EMPTY_MESSAGES", "Send at least one message.")
    if (turns.at(-1)?.role !== "user") {
      throw new ApiError(400, "INVALID_MESSAGES", "The last message must come from the user.")
    }

    const upstream = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${GROQ_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "system",
            content: documentation
              ? `DOCUMENTATION:\n\n${documentation}`
              : "DOCUMENTATION:\n\n(none matched this question)\n\nTell the user this is not covered by Vector's help documentation and suggest they rephrase. Do not answer from memory.",
          },
          ...turns,
        ],
      }),
    })

    if (!upstream.ok) {
      // The upstream body can echo account details, so it is logged rather than
      // returned. The status code is safe to surface and is the difference
      // between a rejected key, a bad model id, and a rate limit — without it
      // every failure looks identical from the client.
      console.error("Groq help request failed", upstream.status, await upstream.text().catch(() => ""))
      throw new ApiError(
        502,
        `HELP_UPSTREAM_${upstream.status}`,
        `The help assistant is unavailable right now (upstream ${upstream.status}).`,
      )
    }

    const payload = (await upstream.json()) as { choices?: { message?: { content?: string } }[] }
    const reply = payload.choices?.[0]?.message?.content?.trim()
    if (!reply) throw new ApiError(502, "HELP_EMPTY", "The help assistant returned an empty response.")
    json(response, 200, { reply, model: MODEL })
  } catch (error) {
    handleApiError(response, error)
  }
}
