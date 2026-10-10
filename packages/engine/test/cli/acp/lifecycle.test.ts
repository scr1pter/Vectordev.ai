import { describe, expect } from "bun:test"
import type {
  CloseSessionResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  ResumeSessionResponse,
} from "@agentclientprotocol/sdk"
import { Duration, Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { expectOk, selectConfigOption } from "./acp-test-client"
import { createAcpClient, initialize, newSession, verifierConfig } from "./helpers"

describe("vector acp lifecycle subprocess", () => {
  cliIt.live(
    "stdin EOF exits cleanly",
    ({ vector }) =>
      Effect.gen(function* () {
        const started = Date.now()
        const acp = yield* vector.acp({ env: { VECTOR_ACP_PROFILE: "1" } })
        acp.close()

        yield* Effect.gen(function* () {
          // The end of stdin is read once the server listens, which a busy Windows runner took more than 5 seconds to
          // reach. A process that never exits still fails well inside the test's minute.
          const code = yield* Effect.promise(() => acp.exited).pipe(Effect.timeout(Duration.seconds(20)))
          expect(code).toBe(0)
        }).pipe(
          Effect.tapCause(() =>
            Effect.sync(() => {
              console.error(
                "[acp immediate EOF]",
                JSON.stringify({ elapsedMs: Date.now() - started, stderr: acp.stderr().slice(-4_000) }),
              )
            }),
          ),
        )
      }),
    60_000,
  )

  cliIt.live(
    "close capability and close request",
    ({ home, llm, vector }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { vector },
          { VECTOR_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        const initialized = yield* initialize(acp)
        expect(initialized.agentCapabilities?.sessionCapabilities?.close).toEqual({})

        const session = yield* newSession(acp, home)
        expectOk(yield* acp.request<CloseSessionResponse>("session/close", { sessionId: session.sessionId }))
      }),
    60_000,
  )

  cliIt.live(
    "loadSession capability and load request return session config options",
    ({ home, llm, vector }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { vector },
          { VECTOR_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        const initialized = yield* initialize(acp)
        expect(initialized.agentCapabilities?.loadSession).toBe(true)
        const session = yield* newSession(acp, home)
        const loaded = expectOk(
          yield* acp.request<LoadSessionResponse>("session/load", {
            cwd: home,
            sessionId: session.sessionId,
            mcpServers: [],
          }),
        )

        expect(selectConfigOption(loaded.configOptions, "model")?.category).toBe("model")
      }),
    60_000,
  )

  cliIt.live(
    "list request includes a live ACP-created session",
    ({ home, llm, vector }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { vector },
          { VECTOR_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        const listed = expectOk(yield* acp.request<ListSessionsResponse>("session/list", { cwd: home }))

        expect(listed.sessions.some((item) => item.sessionId === session.sessionId)).toBe(true)
      }),
    60_000,
  )

  cliIt.live(
    "resume capability advertisement",
    ({ vector }) =>
      Effect.gen(function* () {
        const initialized = yield* initialize(yield* createAcpClient({ vector }))

        expect(initialized.agentCapabilities?.sessionCapabilities?.resume).toEqual({})
      }),
    60_000,
  )

  cliIt.live(
    "resume request returns session config options",
    ({ home, llm, vector }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { vector },
          { VECTOR_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        const resumed = expectOk(
          yield* acp.request<ResumeSessionResponse>("session/resume", {
            cwd: home,
            sessionId: session.sessionId,
            mcpServers: [],
          }),
        )

        expect(selectConfigOption(resumed.configOptions, "model")?.category).toBe("model")
      }),
    60_000,
  )
})
