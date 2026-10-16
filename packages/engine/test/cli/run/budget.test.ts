import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { AssistantMessage, UserMessage } from "@vectordevai/sdk/v2"
import { budgetFrom, exitCodeFor } from "../../../src/cli/cmd/run"
import { cliIt } from "../../lib/cli-process"

const assistant: AssistantMessage = {
  id: "msg_assistant",
  sessionID: "ses_test",
  role: "assistant",
  time: { created: 0, completed: 1 },
  parentID: "msg_user",
  modelID: "test-model",
  providerID: "test",
  mode: "build",
  agent: "build",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

const user: UserMessage = {
  id: "msg_user",
  sessionID: "ses_test",
  role: "user",
  time: { created: 0 },
  agent: "build",
  model: { providerID: "test", modelID: "test-model" },
}

describe("vector run budget flags", () => {
  test("budgetFrom puts --max-cost and --max-steps on the prompt budget", () => {
    expect(budgetFrom({ "max-cost": 2, "max-steps": 60 })).toEqual({ usd: 2, steps: 60 })
    expect(budgetFrom({ "max-cost": 0.5 })).toEqual({ usd: 0.5 })
    expect(budgetFrom({ "max-steps": 10 })).toEqual({ steps: 10 })
    expect(budgetFrom({})).toBeUndefined()
  })

  test("exitCodeFor returns 3 for a spend guard stop, 1 for other errors and 0 otherwise", () => {
    const stopped: AssistantMessage = {
      ...assistant,
      error: {
        name: "BudgetStopError",
        data: {
          reason: "cap",
          message:
            "Spend cap reached: $5.02 spent against a $5.00 cap for this run. Vector stopped after the step that crossed it.",
          spentUsd: 5.02,
          capUsd: 5,
        },
      },
    }
    const failed: AssistantMessage = {
      ...assistant,
      error: { name: "UnknownError", data: { message: "boom" } },
    }
    expect(exitCodeFor(stopped)).toBe(3)
    expect(exitCodeFor(failed)).toBe(1)
    expect(exitCodeFor(assistant)).toBe(0)
    expect(exitCodeFor(user)).toBe(0)
    expect(exitCodeFor(undefined)).toBe(0)
  })

  cliIt.concurrent(
    "a prompt carrying --max-cost and --max-steps is accepted and completes",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.text("within budget")
        const result = yield* vector.run("say hi", { extraArgs: ["--max-cost", "2", "--max-steps", "60"] })
        vector.expectExit(result, 0)
        expect(result.stdout).toBe("within budget\n")
      }),
    60_000,
  )

  cliIt.live(
    "the non-interactive prompt request carries the --max-cost and --max-steps budget",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.text("within budget")
        const server = yield* vector.serve()
        // Relays the CLI's requests to the real server and keeps each prompt body as it left the CLI.
        const prompts: unknown[] = []
        const relay = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              port: 0,
              // The relayed event stream is idle between events.
              idleTimeout: 0,
              hostname: "127.0.0.1",
              async fetch(request) {
                const url = new URL(request.url)
                const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
                if (body && /^\/session\/[^/]+\/message$/.test(url.pathname)) prompts.push(JSON.parse(body))
                const headers = new Headers(request.headers)
                headers.delete("accept-encoding")
                headers.delete("host")
                const response = await fetch(new URL(url.pathname + url.search, server.url), {
                  method: request.method,
                  headers,
                  body,
                })
                // fetch already decoded the body, so the encoding headers no longer describe it.
                const out = new Headers(response.headers)
                out.delete("content-encoding")
                out.delete("content-length")
                out.delete("transfer-encoding")
                return new Response(response.body, { status: response.status, headers: out })
              },
            }),
          ),
          // Not awaited: the relayed event stream stays open until the server behind it is killed after this.
          (relay) => Effect.sync(() => void relay.stop(true)),
        )

        const result = yield* vector.run("say hi", {
          extraArgs: ["--attach", relay.url.origin, "--max-cost", "2", "--max-steps", "60", "--"],
        })

        vector.expectExit(result, 0)
        expect(result.stdout).toBe("within budget\n")
        expect(prompts).toHaveLength(1)
        expect(prompts[0]).toMatchObject({ budget: { usd: 2, steps: 60 } })
      }),
    60_000,
  )

  cliIt.live(
    "rejects budgets the spend guard cannot hold",
    ({ vector }) =>
      Effect.gen(function* () {
        const cost = yield* vector.spawn(["run", "--max-cost", "0", "hello"])
        expect(cost.exitCode).toBe(1)
        expect(cost.stderr).toContain("--max-cost must be a positive number of US dollars")

        const steps = yield* vector.spawn(["run", "--max-steps", "2.5", "hello"])
        expect(steps.exitCode).toBe(1)
        expect(steps.stderr).toContain("--max-steps must be a positive integer")
      }),
    30_000,
  )
})
