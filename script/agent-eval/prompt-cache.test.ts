import { expect, test } from "bun:test"
import { continued, createPromptCache, price, toolsOf, type Recorded } from "./prompt-cache"

const rates = { input: 2, cacheWrite: 0, cacheRead: 0.1, output: 10 }
const tools = [{ type: "function", name: "bash", description: "Run a command. ".repeat(400), parameters: {} }]
const stable = "You are a coding agent. ".repeat(300)

// One Responses request: fixed tools, a fixed developer prompt, then this session's environment and the task.
const responses = (directory: string, ...items: unknown[]): Recorded => ({
  body: {
    tools,
    input: [
      { role: "developer", content: stable },
      { role: "developer", content: `<env>Working directory: ${directory}</env>` },
      ...items,
    ],
  },
  output: "ok",
  sentBytes: 0,
})

test("a later session's first request reads the prefix an earlier session warmed", () => {
  const cache = createPromptCache()
  const first = price([responses("/a", { role: "user", content: "fix it" })], cache, rates)
  const second = price([responses("/b", { role: "user", content: "fix it" })], cache, rates)
  expect(first[0]?.cacheRead).toBe(0)
  // Tools and the fixed prompt are shared; the environment is not. Reads come in 128-token steps.
  expect(second[0]?.cacheRead).toBeGreaterThan(0)
  expect((second[0]?.cacheRead ?? 0) % 128).toBe(0)
  expect(second[0]?.cacheRead).toBeLessThanOrEqual((second[0]?.toolTokens ?? 0) + Math.ceil(stable.length / 4) + 16)
  expect(second[0]?.costUsd).toBeLessThan(first[0]?.costUsd ?? 0)
})

test("a fresh cache gives the same request nothing", () => {
  const warm = createPromptCache()
  price([responses("/a", { role: "user", content: "fix it" })], warm, rates)
  const cold = price([responses("/b", { role: "user", content: "fix it" })], createPromptCache(), rates)
  expect(cold[0]?.cacheRead).toBe(0)
})

test("a prefix shared only partway through a message is read to the token", () => {
  const cache = createPromptCache()
  const merged = (directory: string): Recorded => ({
    body: { tools, input: [{ role: "developer", content: `${stable}<env>Working directory: ${directory}</env>` }] },
    output: "ok",
    sentBytes: 0,
  })
  price([merged("/a")], cache, rates)
  const [second] = price([merged("/b")], cache, rates)
  const whole = (second?.inputTokens ?? 0) - 16
  expect(second?.cacheRead).toBeGreaterThan(whole - 128 - 16)
  expect(second?.cacheRead).toBeLessThan(second?.inputTokens ?? 0)
})

test("an input item's own id is not part of the cached prefix", () => {
  const cache = createPromptCache()
  const tagged = (id: string): Recorded => ({
    body: {
      tools,
      input: [
        { id, role: "developer", content: stable },
        { role: "user", content: id },
      ],
    },
    output: "",
    sentBytes: 0,
  })
  price([tagged("msg_a")], cache, rates)
  const [second] = price([tagged("msg_b")], cache, rates)
  expect(second?.cacheRead).toBeGreaterThan(Math.ceil(stable.length / 4))
})

test("nothing under 1,024 shared tokens is read", () => {
  const cache = createPromptCache()
  const small = (text: string): Recorded => ({
    body: { input: [{ role: "user", content: text }] },
    output: "",
    sentBytes: 0,
  })
  price([small("x".repeat(2_000) + "a")], cache, rates)
  expect(price([small("x".repeat(2_000) + "b")], cache, rates)[0]?.cacheRead).toBe(0)
})

test("Anthropic breakpoints written by one session are read by the next", () => {
  const cache = createPromptCache()
  const messages = (directory: string): Recorded => ({
    body: {
      tools,
      system: [
        { type: "text", text: stable, cache_control: { type: "ephemeral" } },
        { type: "text", text: `<env>${directory}</env>`, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "fix it", cache_control: { type: "ephemeral" } }] }],
    },
    output: "ok",
    sentBytes: 0,
  })
  const [first] = price([messages("/a")], cache, rates)
  const [second] = price([messages("/b")], cache, rates)
  expect(first?.cacheRead).toBe(0)
  expect(second?.cacheRead).toBe(
    (second?.toolTokens ?? 0) + Math.ceil(JSON.stringify({ type: "text", text: stable }).length / 4),
  )
  expect(second?.cacheWrite).toBeGreaterThan(0)
})

test("a continued response is priced on the whole context the provider rebuilds", () => {
  const history = new Map([["resp_1", { input: [{ role: "user", content: "fix it" }], output: [{ type: "message" }] }]])
  const body = continued({ previous_response_id: "resp_1", input: [{ type: "function_call_output" }] }, history)
  expect(body.input).toEqual([
    { role: "user", content: "fix it" },
    { type: "message" },
    { type: "function_call_output" },
  ])
  expect(continued({ input: [{ role: "user" }] }, history).input).toEqual([{ role: "user" }])
})

test("a generate:false warmup is counted as a request of its own", () => {
  const cache = createPromptCache()
  const warmup: Recorded = { body: { tools, generate: false, input: [] }, output: "", sentBytes: 10 }
  const costs = price([warmup, responses("/a", { role: "user", content: "fix it" })], cache, rates)
  expect(costs.map((cost) => cost.who)).toEqual(["warmup", "agent"])
  expect(costs[0]?.costUsd).toBeGreaterThan(0)
})

test("namespaced additional tools identify Codex code mode without losing the transmitted context", () => {
  const request: Recorded = {
    body: {
      input: [
        {
          type: "additional_tools",
          tools: [
            { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: stable }] },
          ],
        },
      ],
    },
    output: "",
    sentBytes: 100,
  }
  expect(toolsOf(request).map((tool) => tool.name)).toEqual(["functions.exec"])
  const costs = price([request], createPromptCache(), rates)
  expect(costs[0]?.who).toBe("agent")
  expect(costs[0]?.inputTokens).toBeGreaterThan(Math.floor(stable.length / 4))
  expect(request.body.input).toHaveLength(1)
})

test("a WebSocket continuation inherits code-mode tools from its complete provider context", () => {
  const input = [
    {
      type: "additional_tools",
      tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }],
    },
    { role: "user", content: "Read the file, then fix it." },
  ]
  const output = [{ type: "custom_tool_call", namespace: "functions", name: "exec", call_id: "call_1" }]
  const sentBody = {
    previous_response_id: "resp_1",
    input: [{ type: "custom_tool_call_output", call_id: "call_1", output: "file contents" }],
  }
  const request = {
    body: continued(sentBody, new Map([["resp_1", { input, output }]])),
    sentBody,
    output: "next tool call",
    sentBytes: JSON.stringify(sentBody).length,
  }
  expect(toolsOf({ ...request, body: sentBody })).toEqual([])
  expect(toolsOf(request).map((tool) => tool.name)).toEqual(["functions.exec"])
  expect(request.body.input).toEqual([...input, ...output, ...sentBody.input])
  expect(request.sentBody.input).toHaveLength(1)
  expect(price([request], createPromptCache(), rates)[0]?.who).toBe("agent")
})
