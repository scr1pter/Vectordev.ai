import { expect, test } from "bun:test"
import { setTimeout as sleep } from "node:timers/promises"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { McpAuth, McpAuthStorage } from "../../src/mcp/auth"

function authFile() {
  let raw = ""
  let activeWrites = 0
  let sawOverlap = false

  const fsLayer = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service

      return FSUtil.Service.of({
        ...fs,
        readFileStringSafe: (file) =>
          file.endsWith("mcp-auth.json")
            ? Effect.succeed(raw || undefined)
            : fs.readFileStringSafe(file),
        writeWithDirs: (file, value, mode) =>
          file.endsWith("mcp-auth.json")
            ? Effect.promise(async () => {
                activeWrites++
                sawOverlap = sawOverlap || activeWrites > 1
                raw = ""
                await sleep(10)
                const next = typeof value === "string" ? value : new TextDecoder().decode(value)
                raw = sawOverlap ? `${next}\n}` : next
                activeWrites--
              })
            : fs.writeWithDirs(file, value, mode),
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))

  return { fsLayer, raw: () => raw }
}

function authService(fsLayer: Layer.Layer<FSUtil.Service>) {
  return McpAuth.Service.use((auth) => Effect.succeed(auth)).pipe(
    Effect.provide(AppNodeBuilder.build(McpAuth.node, [[FSUtil.node, fsLayer]])),
  )
}

test("serializes concurrent auth file updates across service instances", async () => {
  const file = authFile()

  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* authService(file.fsLayer)
      const second = yield* authService(file.fsLayer)

      yield* Effect.all(
        [
          first.updateTokens("posthog", { accessToken: "access-token" }, "https://mcp.posthog.com/mcp"),
          second.updateClientInfo("posthog", { clientId: "client-id" }, "https://mcp.posthog.com/mcp"),
        ],
        { concurrency: "unbounded" },
      )

      const entry = yield* first.get("posthog")
      expect(entry?.tokens?.accessToken).toBe("access-token")
      expect(entry?.clientInfo?.clientId).toBe("client-id")
      expect(entry?.serverUrl).toBe("https://mcp.posthog.com/mcp")
      expect(() => JSON.parse(file.raw())).not.toThrow()
    }),
  )
})

test("encrypts MCP OAuth credentials with Vector's vault key", () => {
  const key = Buffer.alloc(32, 9)
  const encoded = McpAuthStorage.encode(
    {
      posthog: {
        tokens: { accessToken: "access-token" },
        serverUrl: "https://mcp.posthog.com/mcp",
      },
    },
    key,
  )
  expect(encoded).not.toContain("access-token")
  expect(McpAuthStorage.decode(encoded, key).posthog?.tokens?.accessToken).toBe("access-token")
})
