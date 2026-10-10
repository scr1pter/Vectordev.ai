import { ModelPlanStatus } from "../../src/model-plan-status"

export const codiumModel = {
  id: "vendor/coder",
  name: "Coder",
  contextLength: 32_000,
  maxOutputTokens: 4096,
  inputPrice: 0.2,
  outputPrice: 0.4,
}

/** A text reply that calls one tool, followed by OpenRouter's usage chunk carrying the billed cost. */
export const toolCallStream = [
  { id: "gen-1", choices: [{ index: 0, delta: { role: "assistant", content: "Reading the file." } }] },
  {
    id: "gen-1",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } }],
        },
      },
    ],
  },
  {
    id: "gen-1",
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"src/a.ts"}' } }] } }],
  },
  { id: "gen-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  {
    id: "gen-1",
    choices: [],
    usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, cost: 0.00042 },
  },
]

/**
 * A local stand-in for vectordev.ai/api/model-plans: catalog, status and chat, answering like the hosted gateway.
 * forward() sends a request meant for vectordev.ai here instead, so the real client code runs unchanged.
 */
export function codiumGateway(token: string) {
  const state = {
    mode: "ok" as "ok" | "credits" | "disabled" | "context",
    status: {
      enabled: true,
      active: true,
      access: true,
      plan: "vector-20",
      credits: 16,
      remaining: 1.2,
      periodStart: 1_000,
      periodEnd: 1_790_000_000_000,
      cancelAtPeriodEnd: false,
      customer: true,
      wallet: { credits: 8, used: 7.9, remaining: 0.1 },
    } as Record<string, unknown>,
  }
  const seen: { path: string; authorization: string | null; body?: unknown }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const authorization = request.headers.get("authorization")
      seen.push({
        path: url.pathname,
        authorization,
        body: request.method === "POST" ? await request.json() : undefined,
      })
      if (authorization !== `Bearer ${token}`)
        return Response.json(
          { error: { code: "CLI_TOKEN_INVALID", message: "Sign in to Vector again to continue." } },
          { status: 401 },
        )
      if (url.pathname === "/api/model-plans/models")
        return Response.json(
          state.mode === "disabled" ? { enabled: false, models: [] } : { enabled: true, models: [codiumModel] },
        )
      if (url.pathname === "/api/model-plans/status") return Response.json(state.status)
      if (url.pathname !== "/api/model-plans/chat") return new Response("not found", { status: 404 })
      if (state.mode === "disabled")
        return Response.json(
          { error: { code: "MODEL_PLANS_DISABLED", message: "Vector Codium is not available yet." } },
          { status: 503 },
        )
      if (state.mode === "credits")
        return Response.json(
          {
            error: {
              code: "MODEL_PLAN_EXHAUSTED",
              message: "Your included model credits are used up. They renew at the next billing period.",
            },
          },
          { status: 402 },
        )
      if (state.mode === "context")
        return Response.json(
          {
            error: {
              code: "MODEL_PLAN_CONTEXT",
              message:
                "This request may exceed the model context limit. Shorten the conversation or requested response.",
            },
          },
          { status: 400 },
        )
      return new Response(
        [...toolCallStream.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const forward = (url: string, init?: RequestInit) => {
    if (!url.startsWith(`${ModelPlanStatus.SITE}/`)) throw new Error(`Codium requests must go to vectordev.ai: ${url}`)
    return fetch(`${server.url.origin}${url.slice(ModelPlanStatus.SITE.length)}`, init)
  }
  return { server, state, seen, forward, stop: () => server.stop(true) }
}
