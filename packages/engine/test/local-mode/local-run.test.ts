import { afterEach, describe, expect } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import type { ConfigLocalV1 } from "@vectordevai/core/v1/config/local"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { Global } from "@vectordevai/core/global"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Database } from "@vectordevai/core/database/database"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { Git as CoreGit } from "@vectordevai/core/git"
import { SessionRunnerModel } from "@vectordevai/core/session/runner/model"
import { AbsolutePath } from "@vectordevai/core/schema"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin"
import { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ShellTool } from "../../src/tool/shell"
import { AFTER_WEB, WebFetchTool } from "../../src/tool/webfetch"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// Vector Local in the engine, end to end, with nothing leaving this computer: the strict network guard throws on any
// connection that is not to loopback, the model server is the fake one on 127.0.0.1, and the user's own config lists
// it (the test's managed folder stays empty). Each test turns Vector Local on for itself and off again.

const guard = NetworkGuard.use()

afterEach(async () => {
  Egress.configure(LocalPolicy.OFF)
  await Egress.erase()
})

// Turns Vector Local on with `block` in the user's own config, as the owner confirms it, and off again after `body`.
function withLocal<A, E, R>(block: ConfigLocalV1.Info, body: () => Effect.Effect<A, E, R>) {
  const file = path.join(Global.Path.config, "vector.json")
  const apply = () => {
    Config.refreshLocal()
    Config.confirmLocal()
  }
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      writeFileSync(file, JSON.stringify({ local: block }))
      apply()
    }),
    body,
    () =>
      Effect.sync(() => {
        rmSync(file, { force: true })
        apply()
        rmSync(Config.localConfirmedFile(), { force: true })
      }),
  )
}

const qwen = (id: string) => ({
  id,
  name: id,
  tool_call: true,
  cost: { input: 0, output: 0 },
  limit: { context: 100_000, output: 8_000 },
})

describe("the provider under Vector Local", () => {
  const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))
  const BOX = "http://127.0.0.1:9"
  const config: Partial<ConfigV1.Info> = {
    provider: {
      box: {
        name: "GPU box",
        npm: "@ai-sdk/openai-compatible",
        models: { qwen: qwen("qwen") },
        options: { apiKey: "test-key", baseURL: `${BOX}/v1` },
      },
      // A server of the user's own on the internet that is not on the list.
      cloud: {
        name: "Their server",
        npm: "@ai-sdk/openai-compatible",
        models: { big: qwen("big") },
        options: { apiKey: "test-key", baseURL: "https://llm.example.com/v1" },
      },
      // A cloud AI service, which the user cannot list as a server of their own.
      mistral: {
        name: "Mistral",
        npm: "@ai-sdk/openai-compatible",
        models: { codestral: qwen("codestral") },
        options: { apiKey: "test-key", baseURL: "https://api.mistral.ai/v1" },
      },
      ollama: {
        name: "Ollama",
        npm: "@ai-sdk/openai-compatible",
        models: { "qwen3:8b": qwen("qwen3:8b"), "gpt-oss:120b-cloud": qwen("gpt-oss:120b-cloud") },
        options: { apiKey: "ollama", baseURL: `${BOX}/v1` },
      },
    },
  }

  it.instance(
    "lists a configured cloud provider off-in-local and refuses choosing it, with nothing sent",
    () =>
      withLocal({ enabled: true, endpoints: [BOX] }, () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const listed = yield* provider.list()
          expect(Object.keys(listed).toSorted()).toEqual(["box", "ollama"])
          const unavailable = yield* provider.unavailable()
          expect(unavailable).toContainEqual({
            id: "cloud",
            reason: "off-in-local",
            message:
              "cloud: off in Vector Local, because its server is not on your list of model servers. Add the server to the list, or turn Vector Local off to use it.",
          })
          expect(unavailable).toContainEqual({
            id: "mistral",
            reason: "off-in-local",
            message:
              "mistral: off in Vector Local. https://api.mistral.ai is a cloud AI service, not a server you host. Your company's policy can list it, or turn Vector Local off to use it.",
          })
          // Choosing one fails with that notice, before any stream starts.
          const refused = yield* provider
            .getModel(ProviderV2.ID.make("cloud"), ModelV2.ID.make("big"))
            .pipe(Effect.flip)
          expect(refused.unavailable?.reason).toBe("off-in-local")
          expect(refused.message).toContain("Model unavailable: cloud/big.")
          expect(guard.outside()).toEqual([])
        }),
      ),
    { trusted: true, config },
  )

  it.instance(
    "keeps an Ollama cloud model off on a listed Ollama, and its other models on",
    () =>
      withLocal({ enabled: true, endpoints: [BOX] }, () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          expect(Object.keys((yield* provider.list())[ProviderV2.ID.make("ollama")]?.models ?? {})).toEqual([
            "qwen3:8b",
          ])
          const refused = yield* provider
            .getModel(ProviderV2.ID.make("ollama"), ModelV2.ID.make("gpt-oss:120b-cloud"))
            .pipe(Effect.flip)
          expect(refused.unavailable).toEqual({
            id: "ollama",
            reason: "off-in-local",
            message:
              "ollama: off in Vector Local. It is an Ollama cloud model: the Ollama app passes its prompts on to ollama.com. Choose a model that runs on your server, or turn Vector Local off to use it.",
          })
        }),
      ),
    { trusted: true, config },
  )

  it.instance(
    "changes nothing with Vector Local off",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        expect(Object.keys(yield* provider.list()).toSorted()).toEqual(["box", "cloud", "mistral", "ollama"])
        expect(Object.keys((yield* provider.list())[ProviderV2.ID.make("ollama")]?.models ?? {}).toSorted()).toEqual([
          "gpt-oss:120b-cloud",
          "qwen3:8b",
        ])
        expect((yield* provider.unavailable()).filter((item) => item.reason === "off-in-local")).toEqual([])
      }),
    { trusted: true, config },
  )

  it.instance(
    "refuses a signed-in ChatGPT model before any socket or fetch",
    () =>
      withLocal({ enabled: true, endpoints: [BOX] }, () =>
        Effect.gen(function* () {
          const env = yield* Env.Service
          const previous = process.env.VECTOR_AUTH_CONTENT
          const signIn = JSON.stringify({
            openai: { type: "oauth", access: "placeholder", refresh: "placeholder", expires: Date.now() + 60_000 },
          })
          process.env.VECTOR_AUTH_CONTENT = signIn
          yield* env.set("VECTOR_AUTH_CONTENT", signIn)
          const provider = yield* Provider.Service
          const outcome = yield* Effect.gen(function* () {
            const listed = yield* provider.list()
            const refused = yield* provider
              .getModel(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.1-codex"))
              .pipe(Effect.flip)
            return { listed: Object.keys(listed), refused }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (previous === undefined) delete process.env.VECTOR_AUTH_CONTENT
                else process.env.VECTOR_AUTH_CONTENT = previous
              }),
            ),
          )
          expect(outcome.listed).not.toContain("openai")
          expect(outcome.refused.unavailable?.reason).toBe("off-in-local")
          // Nothing tried to reach chatgpt.com, auth.openai.com or api.openai.com.
          expect(guard.attempts().filter((attempt) => !LocalPolicy.loopback(attempt.host))).toEqual([])
        }),
      ),
    {
      trusted: true,
      config: {
        provider: { openai: { models: { "gpt-5.1-codex": qwen("gpt-5.1-codex") }, whitelist: ["gpt-5.1-codex"] } },
      },
    },
  )
})

describe("a Vector Local run", () => {
  const summary = Layer.succeed(
    SessionSummary.Service,
    SessionSummary.Service.of({
      summarize: () => Effect.void,
      diff: () => Effect.succeed([]),
      computeDiff: () => Effect.succeed([]),
    }),
  )
  const lsp = Layer.succeed(
    LSP.Service,
    LSP.Service.of({
      init: () => Effect.void,
      status: () => Effect.succeed([]),
      hasClients: () => Effect.succeed(false),
      touchFile: () => Effect.void,
      diagnostics: () => Effect.succeed({}),
      hover: () => Effect.succeed([]),
      definition: () => Effect.succeed([]),
      references: () => Effect.succeed([]),
      implementation: () => Effect.succeed([]),
      documentSymbol: () => Effect.succeed([]),
      workspaceSymbol: () => Effect.succeed([]),
      prepareCallHierarchy: () => Effect.succeed([]),
      incomingCalls: () => Effect.succeed([]),
      outgoingCalls: () => Effect.succeed([]),
    }),
  )
  const mcp = Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed([]),
      tools: () => Effect.succeed({}),
      cloudTools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      remove: () => Effect.void,
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth"),
      authenticate: () => Effect.die("unexpected MCP auth"),
      finishAuth: () => Effect.die("unexpected MCP auth"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
  const it = testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        SessionPrompt.node,
        Session.node,
        Question.node,
        Ripgrep.node,
        FSUtil.node,
        Database.node,
        LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
      ]),
      [
        [SessionSummary.node, summary],
        [LSP.node, lsp],
        [MCP.node, mcp],
        [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
      ],
    ),
  )
  // A small context, so one large step compacts the history.
  const small = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("tiny-context") }
  const allow = [{ permission: "*", pattern: "*", action: "allow" as const }]

  const setup = Effect.fn("test.setup")(function* () {
    const { directory } = yield* TestInstance
    const llm = yield* TestLLMServer
    const fs = yield* FSUtil.Service
    const file = path.join(directory, "vector.json")
    const config: Partial<ConfigV1.Info> = {
      formatter: false,
      lsp: false,
      sizing: { judge: "thorough" },
      provider: {
        lmstudio: {
          name: "Test",
          id: "lmstudio",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "tiny-context": {
              id: "tiny-context",
              name: "Tiny Context",
              attachment: false,
              reasoning: true,
              temperature: false,
              tool_call: true,
              release_date: "2025-01-01",
              limit: { context: 20_000, output: 2_000 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
          options: { apiKey: "test-key", baseURL: llm.url },
        },
      },
    }
    yield* fs.writeWithDirs(file, JSON.stringify(config))
    const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(directory, [file]))
    yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
    return {
      directory,
      llm,
      origin: new URL(llm.url).origin,
      prompt: yield* SessionPrompt.Service,
      sessions: yield* Session.Service,
    }
  })

  it.instance(
    "sends a title, a compaction, the judge, a subagent and a Vectorscope review to the listed server, as the root session",
    () =>
      Effect.gen(function* () {
        const { llm, origin, prompt, sessions, directory } = yield* setup()
        yield* withLocal({ enabled: true, endpoints: [origin] }, () =>
          Effect.gen(function* () {
            yield* Effect.promise(() => Egress.erase())
            // A new session, so its first request gets a title.
            const chat = yield* sessions.create({})
            // A Thorough request on a small context: a title, a write step that fills the context, the compaction it
            // brings, the step after it and the judge.
            yield* llm.push(
              reply()
                .tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
                .usage({ input: 19_000, output: 100 }),
            )
            yield* llm.text("Summary of the work so far.")
            yield* llm.text("Migrated the router.")
            yield* llm.text("VERDICT: PASS")
            yield* prompt.prompt({
              sessionID: chat.id,
              agent: "build",
              model: small,
              parts: [{ type: "text", text: "be thorough: migrate the app to the new router across 40 files" }],
            })
            const judge = (yield* sessions.children(chat.id)).map((child) => child.id)
            expect(judge).toHaveLength(1)
            const history = yield* sessions.messages({ sessionID: chat.id })
            expect(history.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(true)

            // A subagent of the same session, and a Vectorscope reviewer it launched: both count in the root.
            const child = yield* sessions.create({ title: "Child", parentID: chat.id, permission: allow })
            yield* llm.text("Checked the router.")
            yield* prompt.prompt({
              sessionID: child.id,
              agent: "general",
              model: small,
              parts: [{ type: "text", text: "check the router" }],
            })
            const review = yield* sessions.create({
              title: "Vectorscope review",
              parentID: chat.id,
              internal: "vectorscope.review",
              permission: allow,
            })
            yield* llm.text("No findings.")
            yield* prompt.prompt({
              sessionID: review.id,
              agent: "review",
              model: small,
              parts: [{ type: "text", text: "review the router change" }],
            })

            const hits = yield* llm.hits
            const calls = Egress.events().filter((event) => event.purpose === "inference")
            // Every request the server answered was decided as a model call to it, for the root session.
            expect(calls).toHaveLength(hits.length)
            expect(hits.some((hit) => JSON.stringify(hit.body).includes("Generate a title"))).toBe(true)
            expect(hits.some((hit) => JSON.stringify(hit.body).includes("independent completion judge"))).toBe(true)
            for (const call of calls) {
              expect(call).toMatchObject({
                source: "local-inference",
                origin,
                class: "listed",
                decision: "allow",
                root_session_id: chat.id,
              })
            }
            expect(new Set(calls.map((call) => call.session_id))).toEqual(
              new Set([chat.id, ...judge, child.id, review.id]),
            )
            const counted = Egress.summary(chat.id)
            expect(counted.model_calls).toEqual({ [origin]: hits.length })
            // The reviewer is a helper: its requests roll up into the session that launched it.
            expect(counted.helper_requests).toBe(calls.filter((call) => call.session_id === review.id).length)
            expect(counted.helper_requests).toBeGreaterThan(0)
            expect(counted.blocked).toEqual({})
            expect(guard.outside()).toEqual([])
          }),
        )
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "refuses a model whose server is not on the list before the provider is asked",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        yield* withLocal({ enabled: true, endpoints: ["http://127.0.0.1:9"] }, () =>
          Effect.gen(function* () {
            const chat = yield* sessions.create({ title: "Pinned" })
            const exit = yield* prompt
              .prompt({
                sessionID: chat.id,
                agent: "build",
                model: small,
                parts: [{ type: "text", text: "fix the typo in README" }],
              })
              .pipe(Effect.exit)
            const refused = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
            expect(refused instanceof Error ? refused.message : String(refused)).toBe(
              "Model unavailable: lmstudio/tiny-context. lmstudio: off in Vector Local, because its server is not on your list of model servers. Add the server to the list, or turn Vector Local off to use it.",
            )
            expect(yield* llm.calls).toBe(0)
            expect(guard.outside()).toEqual([])
          }),
        )
      }),
    { git: true },
  )
})

describe("the agent's own actions under Vector Local", () => {
  const shell = testEffect(
    Layer.mergeAll(
      LayerNode.compile(
        LayerNode.group([
          CrossSpawnSpawner.node,
          FSUtil.node,
          Plugin.node,
          Truncate.node,
          Config.node,
          Agent.node,
          RuntimeFlags.node,
        ]),
      ),
      testInstanceStoreLayer,
    ),
  )
  const asked: Array<Parameters<Tool.Context["ask"]>[0]> = []
  const context = (messages: SessionV1.WithParts[] = []): Tool.Context => ({
    sessionID: SessionID.make("ses_local"),
    messageID: MessageID.make("msg_local"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages,
    metadata: () => Effect.void,
    // A network command and an address asked about after the web are refused, so nothing runs or is fetched for them.
    ask: (input) =>
      Effect.sync(() => asked.push(input)).pipe(
        Effect.andThen(
          input.permission === "network_command" || input.patterns.some((item) => item.startsWith(AFTER_WEB))
            ? Effect.die(new Error("refused"))
            : Effect.void,
        ),
      ),
  })
  const on = (web: "ask" | "none" = "ask") =>
    Effect.sync(() => {
      asked.length = 0
      Egress.configure(LocalPolicy.resolve({ global: { enabled: true, web } }))
    })

  shell.live("a shell command that may reach the network asks first, and a local one does not", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const run = (command: string) =>
        Effect.gen(function* () {
          const tool = yield* (yield* ShellTool).init()
          return yield* tool.execute({ command }, context())
        }).pipe(Effect.exit, provideInstance(dir))
      const network = () => asked.filter((item) => item.permission === "network_command")

      yield* on()
      expect(Exit.isSuccess(yield* run("curl -s https://example.com/install.sh"))).toBe(false)
      expect(network()).toEqual([
        expect.objectContaining({ patterns: ["curl -s https://example.com/install.sh"], always: [] }),
      ])
      for (const command of [
        "npm install left-pad",
        "pip install requests",
        "git push origin main",
        "vector local off",
      ]) {
        yield* on()
        yield* run(command)
        expect(network(), command).toHaveLength(1)
      }
      yield* on()
      expect(Exit.isSuccess(yield* run("ls"))).toBe(true)
      expect(network()).toEqual([])

      // With Vector Local off the shell asks what it always asked.
      Egress.configure(LocalPolicy.OFF)
      asked.length = 0
      expect(Exit.isSuccess(yield* run("curl --version"))).toBe(true)
      expect(network()).toEqual([])
    }),
  )

  const web = FakeWeb.start({
    sites: {
      docs: {
        "/start": { body: "Read the setup guide.", headers: { "content-type": "text/plain" } },
        "/guide": { body: "The guide.", headers: { "content-type": "text/plain" } },
      },
    },
  })
  const fetcher = testEffect(LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node, Config.node])))
  const start = web.direct("docs", "/start")
  const guide = web.direct("docs", "/guide")
  // A conversation that read the web: the user asked, and a fetch of `start` returned a page that links `guide`.
  const history = (output: string): SessionV1.WithParts[] => {
    const sessionID = SessionID.make("ses_local")
    const user = MessageID.make("msg_user")
    const assistant = MessageID.make("msg_assistant")
    return [
      {
        info: {
          id: user,
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("qwen") },
        },
        parts: [{ id: PartID.make("prt_user"), messageID: user, sessionID, type: "text", text: `read ${start}` }],
      },
      {
        info: {
          id: assistant,
          sessionID,
          parentID: user,
          role: "assistant",
          time: { created: 2 },
          providerID: ProviderV2.ID.make("lmstudio"),
          modelID: ModelV2.ID.make("qwen"),
          agent: "build",
          mode: "build",
          path: { cwd: "/repository", root: "/repository" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: PartID.make("prt_fetch"),
            messageID: assistant,
            sessionID,
            type: "tool",
            callID: "call_fetch",
            tool: "webfetch",
            state: {
              status: "completed",
              input: { url: start },
              output,
              title: start,
              metadata: {},
              time: { start: 2, end: 3 },
            },
          },
        ],
      },
    ]
  }

  fetcher.instance("after a web read, an address no result gave asks each time, and one a result linked does not", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* WebFetchTool).init()
      const read = (url: string, messages: SessionV1.WithParts[]) =>
        tool.execute({ url, format: "text" }, context(messages)).pipe(Effect.exit)
      const strict = () => asked.filter((item) => item.patterns.some((pattern) => pattern.startsWith(AFTER_WEB)))

      // The page the earlier result linked, on a host already read: the usual ask, with Always for the site.
      yield* on()
      expect(Exit.isSuccess(yield* read(guide, history(`Read the setup guide at ${guide}.`)))).toBe(true)
      expect(strict()).toEqual([])
      expect(asked.find((item) => item.permission === "webfetch")?.always).toEqual([web.origin, `${web.origin}/*`])

      // The same page when no result gave it: a page can steer the agent into putting data in an address.
      yield* on()
      const exfil = `${guide}?q=payments`
      expect(Exit.isSuccess(yield* read(exfil, history("Read the setup guide.")))).toBe(false)
      expect(strict()).toEqual([
        expect.objectContaining({ permission: "webfetch", patterns: [`${AFTER_WEB}${exfil}`], always: [] }),
      ])

      // A host the conversation never reached asks, even when a result named it.
      yield* on()
      const other = `http://localhost:${web.port}/docs/guide`
      expect(Exit.isSuccess(yield* read(other, history(`See ${other}.`)))).toBe(false)
      expect(strict()).toHaveLength(1)

      // Web access None reaches only this computer; with Vector Local off the old rules apply.
      yield* on("none")
      expect(Exit.isSuccess(yield* read("https://docs.example.com/guide", history("Read it.")))).toBe(false)
      expect(asked).toEqual([])
      expect(Egress.events().at(-1)).toMatchObject({ source: "webfetch", decision: "block", rule: "web-none" })
      Egress.configure(LocalPolicy.OFF)
      asked.length = 0
      yield* read(exfil, history("Read the setup guide."))
      expect(strict()).toEqual([])
      expect(guard.outside()).toEqual([])
    }),
  )
})

describe("Vector's own git and the V2 runner under Vector Local", () => {
  const git = testEffect(LayerNode.compile(LayerNode.group([CoreGit.node, CrossSpawnSpawner.node])))

  git.live("decides a git fetch to github.com before git starts, and blocks it with Web access None", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const repo = yield* CoreGit.Service
      const repository = yield* repo.repo.discover(AbsolutePath.make(dir))
      expect(repository).toBeDefined()
      Egress.configure(LocalPolicy.resolve({ global: { enabled: true, web: "none" } }))
      expect(CoreGit.gitEnvironment()).toEqual({ GIT_ALLOW_PROTOCOL: "file" })
      const fetched = yield* repo.sync
        .fetchRemotes(repository!, { remoteUrl: "https://github.com/vectordevai/vector.git" })
        .pipe(Effect.flip)
      expect(fetched.message).toBe(
        "Vector Local blocked a git request to github.com. Web access is set to None, so git reaches no internet server.",
      )
      // A remote by its name is decided by the URL git would use for it.
      yield* Effect.promise(() => Bun.$`git -C ${dir} remote add origin git@github.com:vectordevai/vector.git`.quiet())
      const named = yield* repo.sync.fetchBranch(repository!, { branch: "main" }).pipe(Effect.flip)
      expect(named.message).toContain("Vector Local blocked a git request to github.com.")
      expect(Egress.events().filter((event) => event.source === "git-remote")).toEqual([
        expect.objectContaining({ origin: "https://github.com", decision: "block", rule: "web-none" }),
        expect.objectContaining({ origin: "https://github.com", decision: "block", rule: "web-none" }),
      ])
      // A remote on this computer is never decided.
      expect(CoreGit.remoteRefusal(path.join(dir, "other.git"))).toBeUndefined()
      expect(guard.outside()).toEqual([])
    }),
  )

  git.effect("reads where a git remote connects", () =>
    Effect.sync(() => {
      expect(CoreGit.remoteAddress("https://github.com/org/repo.git")).toBe("https://github.com/")
      expect(CoreGit.remoteAddress("http://git.lan:8080/org/repo.git")).toBe("http://git.lan:8080/")
      expect(CoreGit.remoteAddress("ssh://git@github.com:22/org/repo.git")).toBe("https://github.com:22/")
      expect(CoreGit.remoteAddress("git@github.com:org/repo.git")).toBe("https://github.com/")
      expect(CoreGit.remoteAddress("ext::ssh -o ProxyCommand=x host")).toBe("ext::ssh -o ProxyCommand=x host")
      expect(CoreGit.remoteAddress("/srv/git/repo.git")).toBeUndefined()
      expect(CoreGit.remoteAddress("file:///srv/git/repo.git")).toBeUndefined()
      expect(CoreGit.remoteAddress("C:\\repos\\repo.git")).toBeUndefined()
    }),
  )

  const model = (providerID: string, api: ModelV2.Info["api"]) =>
    ModelV2.Info.make({
      id: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make(providerID),
      name: "Test model",
      api,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      request: { headers: {}, body: {} },
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 100_000, output: 8_000 },
    })

  git.effect("refuses a V2 runner turn on a model off in Vector Local before a route is built", () =>
    Effect.gen(function* () {
      const listed = model("box", {
        id: ModelV2.ID.make("qwen"),
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "http://127.0.0.1:9/v1",
      })
      const cloud = model("anthropic", { id: ModelV2.ID.make("claude"), type: "aisdk", package: "@ai-sdk/anthropic" })
      const free = model("vector", {
        id: ModelV2.ID.make("north"),
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "https://vectordev.ai/api/free-models",
      })
      const unlisted = model("box", {
        id: ModelV2.ID.make("qwen"),
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "http://127.0.0.1:10/v1",
      })
      // With Vector Local off, every model passes.
      for (const item of [listed, cloud, free, unlisted]) yield* SessionRunnerModel.allowedInLocal(item)

      Egress.configure(LocalPolicy.resolve({ global: { enabled: true, endpoints: ["http://127.0.0.1:9"] } }))
      yield* SessionRunnerModel.allowedInLocal(listed)
      const refusal = (item: ModelV2.Info) => SessionRunnerModel.allowedInLocal(item).pipe(Effect.flip)
      expect((yield* refusal(cloud)).message).toBe(
        "anthropic/test-model is off in Vector Local. This service sends your work outside the servers you host, so Vector Local keeps it off.",
      )
      expect((yield* refusal(free)).reason).toBe(
        "Vector's free models and Vector Codium run on vectordev.ai, outside the model servers you host.",
      )
      expect((yield* refusal(unlisted)).reason).toBe("Model calls go only to the model servers on your list.")
    }),
  )
})
