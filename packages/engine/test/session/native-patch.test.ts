import { describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText, streamText, tool, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { JSONSchema7, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import z from "zod"
import { NativePatch } from "@/session/llm/native-patch"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"

const model = { providerID: "openai", api: { npm: "@ai-sdk/openai" } }
const patch = '*** Begin Patch\r\n*** Add File: example.ts\n+const value = "\\path 😀"\n*** End Patch'
const usage = { input_tokens: 91, input_tokens_details: { cached_tokens: 17 }, output_tokens: 19 }
const completed = { type: "response.completed", response: { usage } }
const call = { type: "custom_tool_call", id: "item_patch", call_id: "call_patch", name: "apply_patch", input: patch }

function frames() {
  const split = patch.indexOf("😀") + 1
  return [
    { type: "response.created", response: { id: "response_test", created_at: 1, model: "gpt-6.1-sol" } },
    { type: "response.output_item.added", output_index: 0, item: { ...call, input: "" } },
    ...[patch.slice(0, split), patch.slice(split)].map((delta) => ({
      type: "response.custom_tool_call_input.delta",
      output_index: 0,
      item_id: call.id,
      delta,
    })),
    { type: "response.output_item.done", output_index: 0, item: { ...call, status: "completed" } },
    completed,
  ]
}

function response(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

async function drain(stream: ReadableStream<unknown>) {
  await stream.pipeTo(new WritableStream({ write() {} }))
}

async function serve(
  output: () => Response,
  run: (sdk: ReturnType<typeof createOpenAI>, requests: unknown[]) => Promise<void>,
) {
  const requests: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      return output()
    },
  })
  try {
    await run(createOpenAI({ apiKey: "local-test-only", baseURL: `${server.url.origin}/v1` }), requests)
  } finally {
    server.stop(true)
  }
}

function middleware(patchTool: Tool, options: Record<string, unknown> = {}) {
  return NativePatch.middleware({ model, options: { nativePatch: true, store: false, ...options }, tool: patchTool })
}

function patchTool(execute: (input: { patchText: string }) => unknown = (input) => input) {
  const result = tool({ inputSchema: z.object({ patchText: z.string() }), description: "Apply a patch", execute })
  NativePatch.mark(result)
  return result
}

function params(): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "Make the edit" }] }],
    tools: [
      {
        type: "function",
        name: "apply_patch",
        description: "Apply a patch",
        inputSchema: { type: "object", properties: { patchText: { type: "string" } }, required: ["patchText"] },
      },
    ],
    providerOptions: { openai: { store: false } },
  }
}

describe("OpenAI native patch middleware", () => {
  test("the real SDK sends a custom tool and executes the original object schema exactly once", async () => {
    const executions: unknown[] = []
    const deltas: string[] = []
    const patchTool = tool({
      inputSchema: z.object({ patchText: z.string() }),
      description: "Apply a patch",
      onInputDelta(event) {
        deltas.push(event.inputTextDelta)
      },
      execute(input, options) {
        executions.push({ input, callID: options.toolCallId, hasAbortSignal: !!options.abortSignal })
        return { title: "Applied", output: "done", metadata: { changed: 1 } }
      },
    })
    NativePatch.mark(patchTool)
    await serve(
      () => response(frames()),
      async (sdk, requests) => {
        const result = streamText({
          model: wrapLanguageModel({ model: sdk.responses("gpt-6.1-sol"), middleware: middleware(patchTool) }),
          tools: { apply_patch: patchTool },
          prompt: "Make the edit",
          providerOptions: { openai: { store: false } },
          maxRetries: 0,
          abortSignal: new AbortController().signal,
        })
        const parts = await Array.fromAsync(result.fullStream)
        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({
          tools: [{ type: "custom", name: "apply_patch", format: { type: "text" } }],
        })
        expect(executions).toEqual([{ input: { patchText: patch }, callID: "call_patch", hasAbortSignal: true }])
        expect(JSON.parse(deltas.join(""))).toEqual({ patchText: patch })
        expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
          input: { patchText: patch },
          providerMetadata: { openai: { itemId: "item_patch" } },
        })
        expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
          output: { title: "Applied", output: "done", metadata: { changed: 1 } },
        })
        expect(await result.usage).toMatchObject({ inputTokens: 91, outputTokens: 19 })
        expect(parts.filter((part) => part.type === "error")).toEqual([])
      },
    )
  })

  test.each(["auto", "required", "none"] as const)("preserves %s tool selection", async (choice) => {
    await serve(
      () => response([completed]),
      async (sdk, requests) => {
        const patch = patchTool()
        const wrapped = wrapLanguageModel({ model: sdk.responses("gpt-6.1-sol"), middleware: middleware(patch) })
        const result = await wrapped.doStream({ ...params(), toolChoice: { type: choice } })
        await drain(result.stream)
        expect(requests[0]).toMatchObject({ tool_choice: choice, tools: [{ type: "custom", name: "apply_patch" }] })
      },
    )
  })

  test("forced patch selection stays in JSON mode around the SDK reserved-name collision", async () => {
    await serve(
      () => response([completed]),
      async (sdk, requests) => {
        const wrapped = wrapLanguageModel({ model: sdk.responses("gpt-6.1-sol"), middleware: middleware(patchTool()) })
        await drain(
          (await wrapped.doStream({ ...params(), toolChoice: { type: "tool", toolName: "apply_patch" } })).stream,
        )
        // The adapter does not introduce the custom tool; the pinned SDK's existing
        // reserved-name behavior is intentionally outside this opt-in feature.
        expect(requests[0]).toMatchObject({ tools: [{ type: "function", name: "apply_patch" }] })
      },
    )
  })

  test.each([
    { nativePatch: false },
    { store: true },
    { conversation: "conversation_existing" },
    { previousResponseId: "response_existing" },
  ])("leaves opt-out or stateful requests unchanged: %j", async (options) => {
    const sdk = createOpenAI({ apiKey: "unused-local-key" })
    const input = params()
    const result = await middleware(patchTool(), options).transformParams!({
      type: "stream",
      params: input,
      model: sdk.responses("gpt-6.1-sol"),
    })
    expect(result).toBe(input)
  })

  test("actual wire options, provider, and chat endpoint cannot bypass eligibility", async () => {
    const sdk = createOpenAI({ apiKey: "unused-local-key" })
    const patch = patchTool()
    const inputs = [
      { ...params(), providerOptions: { openai: { store: true } } },
      { ...params(), providerOptions: { openai: { store: false, conversation: "conversation_existing" } } },
      { ...params(), providerOptions: { openai: { store: false, previousResponseId: "response_existing" } } },
    ]
    for (const input of inputs)
      expect(
        await middleware(patch).transformParams!({
          type: "stream",
          params: input,
          model: sdk.responses("gpt-6.1-sol"),
        }),
      ).toBe(input)
    const input = params()
    expect(
      await middleware(patch).transformParams!({ type: "stream", params: input, model: sdk.chat("gpt-6.1-sol") }),
    ).toBe(input)
    const other = NativePatch.middleware({
      model: { ...model, providerID: "other" },
      options: { nativePatch: true, store: false },
      tool: patch,
    })
    expect(await other.transformParams!({ type: "stream", params: input, model: sdk.responses("gpt-6.1-sol") })).toBe(
      input,
    )
  })

  test("unmarked plugin tools stay JSON while a copied builtin retains provenance", async () => {
    const sdk = createOpenAI({ apiKey: "unused-local-key" })
    const input = params()
    const plugin = tool({ inputSchema: z.object({ patchText: z.string() }), execute: (input) => input })
    expect(
      await middleware(plugin).transformParams!({ type: "stream", params: input, model: sdk.responses("gpt-6.1-sol") }),
    ).toBe(input)
    const builtin = { ...patchTool(), strict: false }
    expect(
      await middleware(builtin).transformParams!({
        type: "stream",
        params: input,
        model: sdk.responses("gpt-6.1-sol"),
      }),
    ).toMatchObject({ tools: [{ type: "provider", id: "openai.custom" }] })
  })

  const changedSchemas: JSONSchema7[] = [
    {
      type: "object",
      properties: { patchText: { type: "string" }, extra: { type: "string" } },
      required: ["patchText"],
    },
    {
      type: "object",
      properties: { patchText: { type: "string" }, extra: { type: "string" } },
      required: ["patchText", "extra"],
    },
    { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] },
    { type: "object", properties: { patchText: { type: "number" } }, required: ["patchText"] },
    { type: "object", properties: { patchText: { type: "string", minLength: 5 } }, required: ["patchText"] },
  ]
  test.each(changedSchemas)("definition changes retain the JSON schema contract: %j", async (schema) => {
    const sdk = createOpenAI({ apiKey: "unused-local-key" })
    const input = params()
    input.tools = [{ type: "function", name: "apply_patch", inputSchema: schema }]
    expect(
      await middleware(patchTool()).transformParams!({
        type: "stream",
        params: input,
        model: sdk.responses("gpt-6.1-sol"),
      }),
    ).toBe(input)
  })

  test("stateless history changes representation without mutating durable arguments or metadata", async () => {
    await serve(
      () => response([completed]),
      async (sdk, requests) => {
        const input = params()
        input.prompt.push(
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "old_call",
                toolName: "apply_patch",
                input: { patchText: patch },
                providerOptions: { openai: { itemId: "old_item", retained: "yes" } },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "old_call",
                toolName: "apply_patch",
                output: { type: "error-text", value: "permission denied" },
              },
            ],
          },
        )
        const before = structuredClone(input)
        const wrapped = wrapLanguageModel({
          model: sdk.responses("gpt-6.1-sol"),
          middleware: [
            {
              specificationVersion: "v3",
              async transformParams({ params }) {
                // Exercise the same existing history normalization that precedes the
                // new middleware in LLM, including when the custom tool is disabled.
                return {
                  ...params,
                  prompt: ProviderTransform.message(
                    params.prompt as ModelMessage[],
                    {
                      id: "gpt-6.1-sol",
                      ...model,
                      api: { ...model.api, id: "gpt-6.1-sol" },
                      capabilities: { interleaved: false },
                    } as Provider.Model,
                    { store: false },
                  ) as LanguageModelV3CallOptions["prompt"],
                }
              },
            },
            middleware(patchTool()),
          ],
        })
        await drain((await wrapped.doStream(input)).stream)
        expect(requests[0]).toMatchObject({
          input: [
            { role: "user" },
            { type: "custom_tool_call", call_id: "old_call", input: patch },
            { type: "custom_tool_call_output", call_id: "old_call", output: "permission denied" },
          ],
        })
        expect(JSON.stringify(requests[0])).not.toContain("old_item")
        expect(input).toEqual(before)
        // Permission/user filters remove the advertised tool. Replay still carries
        // object arguments as a function call and never offers a hidden custom tool.
        const disabled = { ...input, tools: [] }
        await drain((await wrapped.doStream(disabled)).stream)
        expect(requests[1]).toMatchObject({
          input: [
            { role: "user" },
            { type: "function_call", call_id: "old_call", arguments: JSON.stringify({ patchText: patch }) },
            { type: "function_call_output", call_id: "old_call", output: "permission denied" },
          ],
        })
        expect(JSON.stringify(requests[1])).not.toContain('"type":"custom"')
        expect(JSON.stringify(requests[1])).not.toContain("old_item")
        await drain(
          (await wrapped.doStream({ ...input, toolChoice: { type: "tool", toolName: "apply_patch" } })).stream,
        )
        expect(JSON.stringify(requests[2])).not.toContain("old_item")
        expect(requests[2]).toMatchObject({
          input: [
            { role: "user" },
            { type: "function_call", call_id: "old_call", arguments: JSON.stringify({ patchText: patch }) },
            { type: "function_call_output", call_id: "old_call", output: "permission denied" },
          ],
        })
      },
    )
  })

  test("unfinished history stays in function mode instead of fabricating patch input", async () => {
    const sdk = createOpenAI({ apiKey: "unused-local-key" })
    const input = params()
    input.prompt.push({
      role: "assistant",
      content: [{ type: "tool-call", toolName: "apply_patch", toolCallId: "interrupted", input: {} }],
    })
    expect(
      await middleware(patchTool()).transformParams!({
        type: "stream",
        params: input,
        model: sdk.responses("gpt-6.1-sol"),
      }),
    ).toBe(input)
  })

  test("non-streaming SDK calls normalize into the same object executor", async () => {
    const inputs: unknown[] = []
    await serve(
      () =>
        Response.json({
          id: "response_test",
          created_at: 1,
          model: "gpt-6.1-sol",
          output: [{ ...call, status: "completed" }],
          usage,
        }),
      async (sdk) => {
        const patch = patchTool((input) => {
          inputs.push(input)
          return "done"
        })
        const result = await generateText({
          model: wrapLanguageModel({ model: sdk.responses("gpt-6.1-sol"), middleware: middleware(patch) }),
          tools: { apply_patch: patch },
          prompt: "Make the edit",
          providerOptions: { openai: { store: false } },
          maxRetries: 0,
        })
        expect(inputs).toEqual([{ patchText: call.input }])
        expect(result.toolResults).toHaveLength(1)
      },
    )
  })

  test("provider failure after partial text does not execute or finish a patch", async () => {
    const inputs: unknown[] = []
    await serve(
      () =>
        response([
          ...frames().slice(0, 3),
          {
            type: "error",
            sequence_number: 4,
            error: { type: "server_error", code: "failed", message: "synthetic failure" },
          },
        ]),
      async (sdk) => {
        const patch = patchTool((input) => {
          inputs.push(input)
          return "done"
        })
        const result = streamText({
          model: wrapLanguageModel({ model: sdk.responses("gpt-6.1-sol"), middleware: middleware(patch) }),
          tools: { apply_patch: patch },
          prompt: "Make the edit",
          providerOptions: { openai: { store: false } },
          maxRetries: 0,
        })
        const parts = await Array.fromAsync(result.fullStream)
        expect(inputs).toEqual([])
        expect(parts.some((part) => part.type === "error")).toBe(true)
        expect(parts.some((part) => part.type === "tool-call" || part.type === "tool-input-end")).toBe(false)
      },
    )
  })

  test("abort during streamed patch input propagates without executing a partial edit", async () => {
    const inputs: unknown[] = []
    const abort = new AbortController()
    await serve(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  frames()
                    .slice(0, 3)
                    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
                    .join(""),
                ),
              )
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      async (sdk) => {
        const patch = patchTool((input) => {
          inputs.push(input)
          return "done"
        })
        const result = streamText({
          model: wrapLanguageModel({ model: sdk.responses("gpt-6.1-sol"), middleware: middleware(patch) }),
          tools: { apply_patch: patch },
          prompt: "Make the edit",
          providerOptions: { openai: { store: false } },
          maxRetries: 0,
          abortSignal: abort.signal,
        })
        for await (const part of result.fullStream) {
          if (part.type === "tool-input-delta") abort.abort()
          expect(part.type).not.toBe("tool-call")
        }
        expect(abort.signal.aborted).toBe(true)
        expect(inputs).toEqual([])
      },
    )
  })
})
