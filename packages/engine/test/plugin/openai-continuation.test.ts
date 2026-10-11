import { describe, expect, test } from "bun:test"
import { OpenAIContinuation } from "../../src/plugin/openai/continuation"

const settings = {
  model: "gpt-6.1-sol",
  instructions: "base",
  tools: [{ type: "function", name: "bash" }],
  store: false,
}
const user = { role: "user", content: [{ type: "input_text", text: "fix the test" }] }
const reasoning = {
  type: "reasoning",
  id: "rs_1",
  summary: [{ type: "summary_text", text: "Run the suite first." }],
  encrypted_content: "enc-1",
}
const call = {
  type: "function_call",
  id: "fc_1",
  status: "completed",
  call_id: "call_1",
  name: "bash",
  arguments: '{"command": "bun test"}',
}
const result = { type: "function_call_output", call_id: "call_1", output: "1 fail" }
// What the client sends back for the server's items: no IDs or status, arguments re-serialized.
const resentReasoning = { type: "reasoning", encrypted_content: "enc-1", summary: reasoning.summary }
const resentCall = { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"command":"bun test"}' }

function completed(body: Record<string, unknown>, output: unknown[] = [reasoning, call]) {
  const tracker = OpenAIContinuation.tracker()
  tracker.observe({ type: "response.created", response: { id: "resp_1", output: [] } })
  output.forEach((item, index) => {
    tracker.observe({ type: "response.output_item.added", output_index: index, item })
    tracker.observe({ type: "response.output_item.done", output_index: index, item })
  })
  tracker.observe({ type: "response.completed", response: { id: "resp_1", output } })
  return tracker.state(body)
}

describe("plugin.openai.continuation", () => {
  test("retains a bounded prefix digest and compares reordered object keys structurally", () => {
    const text = "large history ".repeat(100_000)
    const first = { ...settings, input: [{ role: "user", content: text }] }
    const state = completed(first)
    expect(JSON.stringify(state).length).toBeLessThan(2_000)
    const next = OpenAIContinuation.request(state, {
      ...settings,
      input: [{ content: text, role: "user" }, resentReasoning, resentCall, result],
    })
    expect(next.continued).toBe(true)
    expect(next.body.input).toEqual([result])
    expect(
      OpenAIContinuation.request(state, {
        ...settings,
        input: [{ content: `${text}!`, role: "user" }, resentReasoning, resentCall, result],
      }).continued,
    ).toBe(false)
  })

  test("continues with only the items after the previous response", () => {
    const first = { ...settings, stream: true, input: [user] }
    const state = completed(first)
    const next = OpenAIContinuation.request(state, {
      ...settings,
      stream: true,
      input: [user, resentReasoning, resentCall, result],
    })

    expect(next.continued).toBe(true)
    expect(next.body).toEqual({ ...settings, stream: true, previous_response_id: "resp_1", input: [result] })
  })

  test("accepts the short assistant message form and empty lists the server adds", () => {
    const message = {
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Done.", annotations: [], logprobs: [] }],
    }
    const state = completed({ ...settings, input: [user] }, [message])
    const followUp = { role: "user", content: [{ type: "input_text", text: "thanks" }] }
    const next = OpenAIContinuation.request(state, {
      ...settings,
      input: [
        user,
        { role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] },
        followUp,
      ],
    })

    expect(next.body.input).toEqual([followUp])
  })

  test.each([
    ["the model changes", { model: "gpt-6.1-luna" }],
    ["the instructions change", { instructions: "base, then a new date" }],
    ["the tools change", { tools: [] }],
    ["the reasoning setting changes", { reasoning: { effort: "high" } }],
  ])("sends in full when %s", (_name, change) => {
    const state = completed({ ...settings, input: [user] })
    const next = OpenAIContinuation.request(state, {
      ...settings,
      ...change,
      input: [user, resentReasoning, resentCall, result],
    })

    expect(next.continued).toBe(false)
    expect(next.body.input).toEqual([user, resentReasoning, resentCall, result])
    expect(next.body.previous_response_id).toBeUndefined()
  })

  test.each([
    [
      "an earlier item changed",
      [{ ...user, content: [{ type: "input_text", text: "edited" }] }, resentReasoning, resentCall, result],
    ],
    ["an output item was dropped", [user, resentCall, result]],
    ["an output item was changed", [user, resentReasoning, { ...resentCall, arguments: '{"command":"ls"}' }, result]],
    ["the reasoning summary differs", [user, { ...resentReasoning, summary: [] }, resentCall, result]],
    ["nothing new follows", [user, resentReasoning, resentCall]],
    ["the history was compacted", [{ role: "user", content: [{ type: "input_text", text: "summary" }] }, result]],
  ])("sends in full when %s", (_name, input) => {
    const state = completed({ ...settings, input: [user] })
    const next = OpenAIContinuation.request(state, { ...settings, input })

    expect(next.continued).toBe(false)
    expect(next.body.input).toEqual(input)
  })

  test("leaves a request that manages its own server state alone", () => {
    const state = completed({ ...settings, input: [user] })
    const body = { ...settings, previous_response_id: "resp_mine", input: [result] }

    expect(OpenAIContinuation.request(state, body)).toEqual({ body, continued: false })
  })

  test("matches stored items by reference", () => {
    const state = completed({ ...settings, store: true, input: [user] })
    const next = OpenAIContinuation.request(state, {
      ...settings,
      store: true,
      input: [user, { type: "item_reference", id: "rs_1" }, { type: "item_reference", id: "fc_1" }, result],
    })

    expect(next.body.input).toEqual([result])
  })

  test("records nothing when the server's output is uncertain", () => {
    const body = { ...settings, input: [user] }
    const open = OpenAIContinuation.tracker()
    open.observe({ type: "response.output_item.added", output_index: 0, item: reasoning })
    open.observe({ type: "response.completed", response: { id: "resp_1" } })

    const gap = OpenAIContinuation.tracker()
    gap.observe({ type: "response.output_item.done", output_index: 1, item: call })
    gap.observe({ type: "response.completed", response: { id: "resp_1" } })

    const unindexed = OpenAIContinuation.tracker()
    unindexed.observe({ type: "response.output_item.done", item: call })
    unindexed.observe({ type: "response.completed", response: { id: "resp_1", output: [call] } })

    const disagreeing = OpenAIContinuation.tracker()
    disagreeing.observe({ type: "response.output_item.done", output_index: 0, item: call })
    disagreeing.observe({ type: "response.completed", response: { id: "resp_1", output: [reasoning, call] } })

    const empty = OpenAIContinuation.tracker()
    empty.observe({ type: "response.completed", response: { id: "resp_1", output: [] } })

    const anonymous = OpenAIContinuation.tracker()
    anonymous.observe({ type: "response.output_item.done", output_index: 0, item: call })
    anonymous.observe({ type: "response.completed", response: {} })

    expect([open, gap, unindexed, disagreeing, empty, anonymous].map((tracker) => tracker.state(body))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  test("uses the completed response's list when no item was streamed", () => {
    const tracker = OpenAIContinuation.tracker()
    tracker.observe({ type: "response.completed", response: { id: "resp_9", output: [call] } })

    expect(tracker.state({ ...settings, input: [user] })?.output).toEqual([call])
  })

  test.each([
    [{ type: "error", status: 400, error: { code: "previous_response_not_found", message: "gone" } }, true],
    [{ type: "error", error: { param: "previous_response_id", message: "expired" } }, true],
    [
      { type: "response.failed", response: { error: { message: "Previous response with id 'resp_1' not found." } } },
      true,
    ],
    [{ type: "error", error: { code: "websocket_connection_limit_reached", message: "limit" } }, false],
    [{ type: "error", status: 500, error: { message: "server error" } }, false],
  ])("recognises a lost previous response in %j", (event, expected) => {
    expect(OpenAIContinuation.lost(event)).toBe(expected)
  })
})
