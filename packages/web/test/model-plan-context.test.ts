import { expect, test } from "bun:test"
import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import path from "node:path"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { Token } from "@vectordevai/core/util/token"
import { CODIUM_MODELS } from "../../../api/_lib/codium-catalog"
import { ApiError } from "../../../api/_lib/http"
import { modelPlanRequest, requireModelPlanContext, streamModelPlanResponse } from "../../../api/_lib/model-plan-chat"

// A coding turn as Vector sends it: the engine's real system prompt and tool descriptions, then 50 KB file reads,
// serialized by the Codium client and normalized by the gateway exactly as a chat request is.
const engine = path.join(import.meta.dir, "../../engine/src")
const model = CODIUM_MODELS[0]
const system = await Bun.file(path.join(engine, "session/prompt/default.txt")).text()
const tools = await Promise.all(
  ["read", "edit", "write", "grep", "glob", "task", "todowrite", "webfetch", "websearch", "apply_patch", "lsp"].map(
    async (name) => ({
      type: "function",
      function: {
        name,
        description: await Bun.file(path.join(engine, `tool/${name}.txt`)).text(),
        parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
      },
    }),
  ),
)
const source = (await Bun.file(path.join(engine, "provider/provider.ts")).text()).slice(0, 50_000)

const turn = (reads: number) => {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: "Fix the provider fallback bug and add a test." },
    ...Array.from({ length: reads }, (_, index) => [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${index}`,
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ filePath: `src/file-${index}.ts` }) },
          },
        ],
      },
      { role: "tool", tool_call_id: `call_${index}`, content: source },
    ]).flat(),
  ]
  return {
    body: modelPlanRequest(
      JSON.parse(ModelPlans.serializeRequest({ messages, tools, max_tokens: model.maxOutputTokens }, model)),
      [model],
    ),
    // What Vector itself estimates for the same conversation, four characters per token.
    estimate: Token.estimate(
      [system, ...tools.map((tool) => tool.function.description), ...messages.map((item) => item.content ?? "")].join(
        "",
      ),
    ),
  }
}

test("the conversation that used to be refused at about 30k tokens now fits the advertised window", () => {
  const current = turn(2)
  // Over 120 KB of request: counting bytes as tokens refused this.
  expect(Buffer.byteLength(JSON.stringify(current.body))).toBeGreaterThan(120_000)
  expect(requireModelPlanContext(current.body, model) + model.maxOutputTokens).toBeLessThanOrEqual(model.contextLength)
})

test("the gateway counts about what Vector counts for the same conversation", () => {
  for (const reads of [2, 4, 8]) {
    const current = turn(reads)
    const counted = requireModelPlanContext(current.body, model)
    expect(counted / current.estimate).toBeGreaterThan(0.9)
    expect(counted / current.estimate).toBeLessThan(1.1)
  }
})

test("a conversation the engine has not yet compacted is accepted, and one past the window is refused", () => {
  // The engine compacts once a step reaches the window less the reply, 119,808 tokens for this model.
  const long = turn(8)
  expect(long.estimate).toBeGreaterThan(100_000)
  expect(long.estimate).toBeLessThan(model.contextLength - model.maxOutputTokens)
  expect(() => requireModelPlanContext(long.body, model)).not.toThrow()
  const over = turn(24)
  expect(over.estimate).toBeGreaterThan(model.contextLength)
  expect(() => requireModelPlanContext(over.body, model)).toThrow(
    expect.objectContaining({ statusCode: 400, code: "MODEL_PLAN_CONTEXT" }),
  )
})

test("a provider refusing the context gets the gateway's own context answer, so Vector compacts instead of retrying", async () => {
  const refusals = [
    Response.json(
      {
        error: {
          code: 400,
          message:
            "This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens.",
        },
      },
      { status: 400 },
    ),
    Response.json({ error: { code: "context_length_exceeded", message: "Input too long" } }, { status: 400 }),
    new Response("Request Entity Too Large", { status: 413 }),
  ]
  const failures = await Promise.all(
    refusals.map((upstream) =>
      streamModelPlanResponse(upstream, new ServerResponse(new IncomingMessage(new Socket()))).catch(
        (error: unknown) => error,
      ),
    ),
  )
  expect(failures.every((failure) => failure instanceof ApiError)).toBe(true)
  expect(failures).toEqual(
    refusals.map(() => expect.objectContaining({ statusCode: 400, code: "MODEL_PLAN_CONTEXT" })),
  )
  expect(failures.filter((failure) => failure instanceof ApiError && failure.message.includes("131072"))).toEqual([])
  // The engine and the Core V2 runner read this answer as a context overflow.
  expect(
    failures
      .filter((failure) => failure instanceof ApiError)
      .map((failure) =>
        ModelPlans.contextFailure(JSON.stringify({ error: { code: failure.code, message: failure.message } })),
      ),
  ).toEqual([true, true, true])
  // Any other refusal stays a temporary failure, and the provider's wording never reaches Vector.
  await expect(
    streamModelPlanResponse(
      Response.json({ error: { message: "private upstream detail" } }, { status: 400 }),
      new ServerResponse(new IncomingMessage(new Socket())),
    ),
  ).rejects.toMatchObject({
    statusCode: 503,
    code: "MODEL_PLAN_UPSTREAM",
    message: "This model is temporarily unavailable.",
  })
})
