import { describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { streamText } from "ai"
import { ResponseTerminal } from "../../src/provider/response-terminal"

function response(chunks: string[]) {
  const canceled = Promise.withResolvers<void>()
  return {
    canceled: canceled.promise,
    value: new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk)))
          // Deliberately stay open after the terminal event, as an upstream keepalive can.
        },
        cancel() {
          canceled.resolve()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  }
}

describe("provider response terminal", () => {
  test.each(["\n", "\r\n"])(
    "preserves fragmented terminal usage and closes without waiting for HTTP EOF (%j)",
    async (newline) => {
      const body = `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 123, output_tokens: 45 } } })}${newline}${newline}`
      const source = response([body.slice(0, 17), body.slice(17, -1), body.slice(-1)])
      expect(await ResponseTerminal.wrap(source.value).text()).toBe(body)
      await source.canceled
    },
  )

  test("does not mistake terminal names inside text for a protocol event", async () => {
    const body = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "response.completed" })}\n\ndata: [DONE]\n\n`
    const source = response([body])
    expect(await ResponseTerminal.wrap(source.value).text()).toBe(body)
    await source.canceled
  })

  test("the actual OpenAI SDK finishes with terminal usage while the source remains open", async () => {
    const source = response([
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_terminal", created_at: 1, model: "gpt-5.2", service_tier: null } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_terminal", incomplete_details: null, service_tier: null, usage: { input_tokens: 123, input_tokens_details: { cached_tokens: 100 }, output_tokens: 45, output_tokens_details: { reasoning_tokens: 12 } } } })}\n\n`,
    ])
    const provider = createOpenAI({
      apiKey: "test-key",
      fetch: Object.assign(async () => ResponseTerminal.wrap(source.value), { preconnect: fetch.preconnect }),
    })
    const result = streamText({ model: provider.responses("gpt-5.2"), prompt: "test", maxRetries: 0 })
    await result.consumeStream()
    const usage = await result.totalUsage
    expect(usage.inputTokens).toBe(123)
    expect(usage.outputTokens).toBe(45)
    expect(usage.inputTokenDetails.cacheReadTokens).toBe(100)
    expect(usage.outputTokenDetails.reasoningTokens).toBe(12)
    await source.canceled
  })

  test("the actual Anthropic SDK keeps prompt, cache, and final output usage", async () => {
    const frames = [
      {
        type: "message_start",
        message: {
          id: "msg_terminal",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-5",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 23, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 1 },
        },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 45 } },
      { type: "message_stop" },
    ]
    const source = response(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`))
    const provider = createAnthropic({
      apiKey: "test-key",
      fetch: Object.assign(async () => ResponseTerminal.wrap(source.value), { preconnect: fetch.preconnect }),
    })
    const result = streamText({ model: provider("claude-sonnet-4-5"), prompt: "test", maxRetries: 0 })
    await result.consumeStream()
    const usage = await result.totalUsage
    expect(usage.inputTokens).toBe(133)
    expect(usage.outputTokens).toBe(45)
    expect(usage.inputTokenDetails.cacheReadTokens).toBe(100)
    expect(usage.inputTokenDetails.cacheWriteTokens).toBe(10)
    await source.canceled
  })
})
