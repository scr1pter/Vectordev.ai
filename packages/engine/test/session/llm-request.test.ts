import { describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { jsonSchema, streamText, tool } from "ai"
import { Effect } from "effect"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { LLMRequestPrep } from "@/session/llm/request"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "@/session/system"

type Input = Parameters<typeof LLMRequestPrep.prepare>[0]

const model = (id: string, npm: string, providerID: string, reasoning = true) =>
  ({
    id: `${providerID}/${id}`,
    providerID,
    api: { id, url: "https://example.invalid", npm },
    name: id,
    capabilities: {
      temperature: false,
      reasoning,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 400_000, output: 128_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-04-23",
  }) as unknown as Input["model"]

const gpt = model("gpt-5.5", "@ai-sdk/openai", "openai")
const claude = model("claude-sonnet-4-5", "@ai-sdk/anthropic", "anthropic")
const STABLE = "<subagent_policy>Do the work yourself by default.</subagent_policy>"
const session = (directory: string) => [
  `<env>\n  Working directory: ${directory}\n  Today's date: Sat Oct 10 2026\n</env>`,
  "Instructions from: AGENTS.md\nRun tests from package directories.",
]

function input(options: { model: Input["model"]; directory: string; oauth?: boolean; stable?: boolean }): Input {
  return {
    user: {
      id: "msg_test",
      sessionID: "ses_test",
      role: "user",
      time: { created: 1 },
      agent: "build",
      system: "Answer in British English.",
      model: { providerID: ProviderV2.ID.make(options.model.providerID), modelID: ModelV2.ID.make(options.model.id) },
    } as Input["user"],
    sessionID: `ses_${options.directory.replaceAll("/", "")}`,
    model: options.model,
    agent: { name: "build", mode: "primary", options: {}, permission: [] },
    ...(options.stable === false ? {} : { stableSystem: [STABLE] }),
    system: session(options.directory),
    messages: [{ role: "user", content: "Fix the failing test." }],
    tools: {
      read: tool({ description: "Read a file", inputSchema: jsonSchema({ type: "object", properties: {} }) }),
    },
    provider: {
      id: ProviderV2.ID.make(options.model.providerID),
      name: options.model.providerID,
      source: "config",
      env: [],
      options: {},
      models: {},
    },
    auth: options.oauth ? { type: "oauth", access: "placeholder", refresh: "placeholder", expires: 0 } : undefined,
    plugin: {
      trigger: (_name, _input, output) => Effect.succeed(output),
      list: () => Effect.succeed([]),
      init: () => Effect.void,
    },
    flags: { outputTokenMax: 32_000, client: "test" } as Input["flags"],
    isWorkflow: false,
  }
}

const prepare = (value: Input) => Effect.runPromise(LLMRequestPrep.prepare(value))
const systemMessages = (prepared: LLMRequestPrep.Prepared) =>
  prepared.messages.flatMap((message) => (message.role === "system" ? [message.content] : []))

describe("system prompt layout across sessions", () => {
  test("a ChatGPT sign-in keeps instructions the same from session to session and sends the session after them", async () => {
    const first = await prepare(input({ model: gpt, directory: "/work/a", oauth: true }))
    const second = await prepare(input({ model: gpt, directory: "/work/b", oauth: true }))
    const instructions = first.params.options.instructions as string

    expect(instructions).toBe(second.params.options.instructions)
    expect(instructions.startsWith(SystemPrompt.provider(gpt)[0])).toBe(true)
    expect(instructions).toContain(STABLE)
    expect(instructions).not.toContain("Working directory")
    expect(instructions).not.toContain("AGENTS.md")
    expect(instructions).not.toContain("British English")
    // Nothing is dropped: the per-session block follows as one system (developer) message, then the conversation.
    expect(systemMessages(first)).toEqual([[...session("/work/a"), "Answer in British English."].join("\n")])
    expect(first.messages.at(-1)).toEqual({ role: "user", content: "Fix the failing test." })
  })

  // gpt-6.1-sol is a model the SDK does not know as a reasoning model, and codex-mini-latest without reasoning would get
  // a system item from the SDK on its own: the per-session block still goes as a developer item, as the Codex CLI sends
  // its environment.
  test.each([
    gpt,
    model("gpt-6.1-sol", "@ai-sdk/openai", "openai"),
    model("codex-mini-latest", "@ai-sdk/openai", "openai", false),
  ])(
    "the real SDK sends $api.id as instructions, then a developer item, with the session as cache key",
    async (selected) => {
      const requests: Array<Record<string, unknown>> = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requests.push((await request.json()) as Record<string, unknown>)
          const events = [
            { type: "response.created", response: { id: "resp_1", created_at: 1, model: selected.api.id } },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ]
          return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      const value = input({ model: selected, directory: "/work/a", oauth: true })
      const prepared = await prepare(value)
      const sdk = createOpenAI({ apiKey: "local-test-only", baseURL: `${server.url.origin}/v1` })
      await streamText({
        model: sdk.responses(selected.api.id),
        messages: prepared.messages,
        tools: prepared.tools,
        providerOptions: ProviderTransform.providerOptions(selected, prepared.params.options),
      }).consumeStream()
      server.stop(true)

      const body = requests[0] ?? {}
      expect(body.instructions).toBe(prepared.params.options.instructions)
      expect(body.input).toEqual([
        { role: "developer", content: systemMessages(prepared)[0] },
        { role: "user", content: [{ type: "input_text", text: "Fix the failing test." }] },
      ])
      expect(body.prompt_cache_key).toBe(value.sessionID)
    },
  )

  test("without stable parts a ChatGPT sign-in sends everything as instructions, as before", async () => {
    const prepared = await prepare(input({ model: gpt, directory: "/work/a", oauth: true, stable: false }))
    expect(prepared.params.options.instructions).toContain("Working directory: /work/a")
    expect(systemMessages(prepared)).toEqual([])
  })

  test("an API key keeps one system block with the stable parts ahead of the session", async () => {
    const prepared = await prepare(input({ model: gpt, directory: "/work/a" }))
    const [block] = systemMessages(prepared)
    expect(prepared.params.options.instructions).toBeUndefined()
    expect(systemMessages(prepared)).toHaveLength(1)
    expect(block?.indexOf(STABLE)).toBeLessThan(block?.indexOf("Working directory") ?? -1)
  })

  test("a model that takes cache breakpoints gets the stable block first and the session block after it", async () => {
    const first = await prepare(input({ model: claude, directory: "/work/a" }))
    const second = await prepare(input({ model: claude, directory: "/work/b" }))
    expect(systemMessages(first)).toHaveLength(2)
    expect(systemMessages(first)[0]).toBe(systemMessages(second)[0])
    expect(systemMessages(first)[0]).not.toContain("Working directory")
    expect(systemMessages(first)[1]).toContain("Working directory: /work/a")
    expect(systemMessages(first)[1]).toContain("British English")
    // The stable block carries its own breakpoint, so tools plus the stable block are cached for every session.
    const [stable] = ProviderTransform.message(first.messages, claude, {})
    expect(stable?.providerOptions?.anthropic).toEqual({ cacheControl: { type: "ephemeral" } })
  })

  test("tools go out in name order whatever order they were offered in", async () => {
    const value = input({ model: gpt, directory: "/work/a" })
    const schema = jsonSchema({ type: "object", properties: {} })
    const prepared = await prepare({
      ...value,
      tools: {
        todowrite: tool({ description: "Track work", inputSchema: schema }),
        bash: tool({ description: "Run a command", inputSchema: schema }),
        read: tool({ description: "Read a file", inputSchema: schema }),
      },
    })
    expect(Object.keys(prepared.tools)).toEqual(["bash", "read", "todowrite"])
  })
})
