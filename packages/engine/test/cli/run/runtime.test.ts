import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { VectorClient } from "@vectordevai/sdk/v2"
import { runInteractiveMode } from "@/cli/cmd/run/runtime"
import type { SessionTurnInput } from "@/cli/cmd/run/stream.transport"
import type { FooterApi, RunProvider } from "@/cli/cmd/run/types"

type SessionMessage = NonNullable<Awaited<ReturnType<VectorClient["session"]["messages"]>>["data"]>[number]

const provider: RunProvider = {
  id: "openai",
  name: "OpenAI",
  source: "api",
  env: [],
  options: {},
  models: {
    "gpt-5": {
      id: "gpt-5",
      providerID: "openai",
      api: {
        id: "openai",
        url: "https://openai.test",
        npm: "@ai-sdk/openai",
      },
      name: "Little Frank",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      limit: {
        context: 128000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
  },
}

const transportProviders: RunProvider[][] = []

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ok<T>(data: T) {
  return Promise.resolve({
    data,
    error: undefined,
    request: new Request("https://vector.test"),
    response: new Response(),
  })
}

function footer(): FooterApi {
  let closed = false
  const closes = new Set<() => void>()

  const notify = () => {
    for (const fn of closes) fn()
  }

  return {
    get isClosed() {
      return closed
    },
    onPrompt: () => () => {},
    onQueuedRemove: () => () => {},
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }

      closes.add(fn)
      return () => {
        closes.delete(fn)
      }
    },
    event() {},
    append() {},
    idle() {
      return Promise.resolve()
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
    destroy() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
  }
}

afterEach(() => {
  mock.restore()
  transportProviders.length = 0
})

describe("run interactive runtime", () => {
  for (const dataPolicy of ["may-train", "no-training"] as const) {
    test(`a free model ${dataPolicy === "may-train" ? "that may train shows its notice once, before" : "that does not train shows no notice before"} the first request`, async () => {
      const sdk = new VectorClient()
      const shared = {
        ...provider,
        id: "vector",
        models: {
          "maker/free:free": {
            ...provider.models["gpt-5"],
            id: "maker/free:free",
            providerID: "vector",
            name: "Maker Free",
            freeModel: { source: "shared" as const, dataPolicy },
          },
        },
      }
      spyOn(sdk.config, "providers").mockImplementation(() => ok({ providers: [shared], default: {} }))
      spyOn(sdk.session, "messages").mockImplementation(() => ok([]))
      spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
      spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
      spyOn(sdk.command, "list").mockImplementation(() => ok([]))
      const output = footer()
      const order: string[] = []
      spyOn(output, "append").mockImplementation((commit) => {
        if (commit.kind === "system") order.push(commit.text)
      })
      await runInteractiveMode(
        {
          sdk,
          directory: "/tmp",
          sessionID: "ses-free-notice",
          agent: "build",
          model: { providerID: "vector", modelID: "maker/free:free" },
          variant: undefined,
          files: [],
          initialInput: "hello",
          thinking: false,
          backgroundSubagents: false,
        },
        {
          createRuntimeLifecycle: async () => ({
            footer: output,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
          streamTransport: Promise.resolve({
            createSessionTransport: async () => ({
              runPromptTurn: async () => {
                order.push("request")
                output.close()
              },
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }),
            formatUnknownError: (error: unknown) => String(error),
          }),
        },
      )
      const notices = order.filter((text) => text.includes("May train on your prompts"))
      expect(order).toContain("request")
      if (dataPolicy === "no-training") {
        expect(notices).toEqual([])
        return
      }
      expect(notices).toHaveLength(1)
      // The label alone, with no disclaimer paragraph.
      expect(notices[0]).toEndWith("Maker Free · May train on your prompts")
      expect(notices[0]).not.toContain("Vector itself never trains on your prompts.")
      expect(order.indexOf(notices[0])).toBeLessThan(order.indexOf("request"))
    })
  }

  test("waits for provider metadata before eager replay transport bootstrap", async () => {
    const providersStarted = defer<void>()
    const providers = defer<void>()

    const sdk = new VectorClient()
    spyOn(sdk.config, "providers").mockImplementation(async () => {
      providersStarted.resolve()
      await providers.promise
      return ok({ providers: [provider], default: {} })
    })
    spyOn(sdk.session, "messages").mockImplementation(() =>
      ok([
        {
          info: {
            id: "msg-user-1",
            sessionID: "ses-1",
            role: "user",
            time: {
              created: 1,
            },
            agent: "build",
            model: {
              providerID: "openai",
              modelID: "gpt-5",
              variant: undefined,
            },
          },
          parts: [
            {
              id: "part-user-1",
              sessionID: "ses-1",
              messageID: "msg-user-1",
              type: "text",
              text: "hello",
            },
          ],
        } satisfies SessionMessage,
      ]),
    )
    spyOn(sdk.session, "get").mockRejectedValue(new Error("not needed"))
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: true,
        replay: true,
        replayLimit: 100,
        agent: "build",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
        variant: undefined,
        files: [],
        thinking: true,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: footer(),
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async (input: { providers?: () => RunProvider[]; footer: FooterApi }) => {
            transportProviders.push(input.providers?.() ?? [])
            setTimeout(() => {
              input.footer.close()
            }, 0)
            return {
              runPromptTurn: async () => {},
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }
          },
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    await providersStarted.promise

    expect(transportProviders).toEqual([])

    providers.resolve()

    await task

    expect(transportProviders).toEqual([[provider]])
  })

  test("sends the --max-cost and --max-steps budget on every interactive prompt turn", async () => {
    const sdk = new VectorClient()
    spyOn(sdk.config, "providers").mockImplementation(() => ok({ providers: [provider], default: {} }))
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))
    const turns: SessionTurnInput[] = []

    await runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: false,
        replay: false,
        agent: "build",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
        variant: undefined,
        budget: { usd: 2, steps: 60 },
        files: [],
        initialInput: "say hi",
        thinking: true,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: footer(),
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async (input: { footer: FooterApi }) => ({
            runPromptTurn: async (turn: SessionTurnInput) => {
              turns.push(turn)
              input.footer.close()
            },
            selectSubagent: () => {},
            replayOnResize: async () => false,
            close: async () => {},
          }),
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    expect(turns.map((turn) => [turn.prompt.text, turn.budget])).toEqual([["say hi", { usd: 2, steps: 60 }]])
  })
})
