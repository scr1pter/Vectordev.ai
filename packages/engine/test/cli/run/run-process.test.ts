// Subprocess integration tests for `vector run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `vector.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `VECTOR_CONFIG_CONTENT` providing the test provider config inline.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

function lastUserText(body: Record<string, unknown>) {
  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : []
  const user = messages.findLast((message) => isRecord(message) && message.role === "user")
  const content = isRecord(user) ? user.content : undefined
  if (typeof content === "string") return content
  const parts: unknown[] = Array.isArray(content) ? content : []
  return parts.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n")
}

// Resolves a while after something first waits on it, not after it is made.
function later(ms: number): PromiseLike<void> {
  return {
    then: (fulfilled, rejected) => new Promise<void>((resolve) => setTimeout(resolve, ms)).then(fulfilled, rejected),
  }
}

describe("vector run (non-interactive subprocess)", () => {
  // Happy path: prompt completes, output reaches stdout, process exits 0.
  // If this fails, all the others likely will too — debug here first.
  cliIt.concurrent(
    "exits 0 and writes the response to stdout on a successful prompt",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* vector.run("say hi")
        vector.expectExit(result, 0)
        expect(result.stdout).toBe("hello from the test llm\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "prints each completed text part in order around a tool continuation",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("  before tool  ").tool("bash", {
            command: "printf tool-output",
            description: "Print deterministic output",
          }),
        )
        yield* llm.text("  after tool  ")

        const result = yield* vector.run("use a tool", {
          extraArgs: ["--dangerously-skip-permissions"],
        })

        vector.expectExit(result, 0)
        expect(result.stdout).toBe("before tool\nafter tool\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "prints reasoning before text only with --thinking",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.reason("  considering  ", { text: "  answer  " })
        const thinking = yield* vector.run("think", { extraArgs: ["--thinking"] })
        vector.expectExit(thinking, 0)
        expect(thinking.stdout).toBe("Thinking: considering\nanswer\n")

        yield* llm.reason("hidden", { text: "visible" })
        const plain = yield* vector.run("think again")
        vector.expectExit(plain, 0)
        expect(plain.stdout).toBe("visible\n")
      }),
    60_000,
  )

  // Regression for #27371: an unknown model used to hang the process forever
  // waiting on a session.status === idle event that never arrived. The fix
  // makes the SDK call surface an error promptly so the process exits nonzero.
  // We assert nonzero exit AND wall-clock under the harness timeout — a hang
  // would expire the timeout and produce a different (signal-killed) failure.
  cliIt.concurrent(
    "exits nonzero without reaching the process timeout when the model is unknown (regression for #27371)",
    ({ vector }) =>
      Effect.gen(function* () {
        const result = yield* vector.run("say hi", {
          model: "lmstudio/nonexistent-model",
          timeoutMs: 20_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.timedOut).toBe(false)
      }),
    30_000,
  )

  // The test provider's SSE error item is interpreted by the SDK as an unknown
  // finish, not a fatal provider/session error. Lock that distinction in so it
  // is not accidentally used as the failure compatibility oracle.
  cliIt.concurrent(
    "unknown stream finish preserves partial output and exits 0",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial response").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.fail("upstream provider exploded mid-stream")
        const result = yield* vector.run("trigger midstream error", { timeoutMs: 30_000 })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("partial response\n")
        expect(result.stderr).not.toContain("upstream provider exploded mid-stream")
      }),
    60_000,
  )

  // --format json puts one JSON object per line on stdout for each emitted
  // event. Consumers (CI scripts, tooling) parse this stream. Asserts the
  // shape so a future event-emit change has to update this expectation.
  cliIt.concurrent(
    "--format json emits parseable line-delimited JSON to stdout",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.text("structured output")
        const result = yield* vector.run("say hi", { format: "json" })
        vector.expectExit(result, 0)

        const events = vector.parseJsonEvents(result.stdout)
        expect(events.length).toBeGreaterThan(0)
        for (const evt of events) {
          expect(typeof evt.type).toBe("string")
          expect(typeof evt.sessionID).toBe("string")
        }
        expect(events.map((event) => event.type)).toEqual(["step_start", "text", "step_finish"])
        expect(events.map(({ timestamp: _, sessionID: __, ...event }) => event)).toEqual([
          { type: "step_start", part: expect.objectContaining({ type: "step-start" }) },
          {
            type: "text",
            part: expect.objectContaining({ type: "text", text: "structured output" }),
          },
          { type: "step_finish", part: expect.objectContaining({ type: "step-finish" }) },
        ])
        expect(result.stdout.endsWith("\n")).toBe(true)
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .every((line) => line.length > 0),
        ).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--format json emits a pure error record for a rejected prompt request",
    ({ vector }) =>
      Effect.gen(function* () {
        const result = yield* vector.run("use an unknown model", {
          model: "lmstudio/nonexistent-model",
          format: "json",
        })

        expect(result.exitCode).not.toBe(0)
        expect(result.timedOut).toBe(false)
        const events = vector.parseJsonEvents(result.stdout)
        expect(
          events.map((event) => event.type),
          result.stdout,
        ).toEqual(["error"])
        expect(events[0]).toEqual({
          type: "error",
          timestamp: expect.any(Number),
          sessionID: expect.any(String),
          error: expect.any(Object),
        })
        expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(1)
      }),
    30_000,
  )

  cliIt.concurrent(
    "--format json reports a rejected command request once when it also publishes a session error",
    ({ vector }) =>
      Effect.gen(function* () {
        const result = yield* vector.run("arguments", { command: "missing-command-fixture", format: "json" })
        expect(result.exitCode).not.toBe(0)
        expect(result.timedOut).toBe(false)
        const events = vector.parseJsonEvents(result.stdout)
        expect(
          events.map((event) => event.type),
          result.stdout,
        ).toEqual(["error"])
        expect(events[0]?.error).toEqual(expect.any(Object))
        expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(1)
      }),
    30_000,
  )

  cliIt.concurrent(
    "--format json preserves reasoning, tool, and continuation ordering",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().reason("reasoning").text("before").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.text("after")

        const result = yield* vector.run("exercise json records", {
          format: "json",
          extraArgs: ["--thinking", "--dangerously-skip-permissions"],
        })

        expect(result.exitCode).toBe(0)
        const events = vector.parseJsonEvents(result.stdout)
        expect(events.map((event) => event.type)).toEqual([
          "step_start",
          "reasoning",
          "text",
          "tool_use",
          "step_finish",
          "step_start",
          "text",
          "step_finish",
        ])
        expect(events.find((event) => event.type === "reasoning")?.part).toEqual(
          expect.objectContaining({ type: "reasoning", text: "reasoning" }),
        )
        expect(events.find((event) => event.type === "tool_use")?.part).toEqual(
          expect.objectContaining({
            type: "tool",
            tool: "bash",
            state: expect.objectContaining({ status: "completed" }),
          }),
        )
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .every((line) => line.startsWith("{")),
        ).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--format json reports a subagent's steps so the run's spend is complete",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.tool("task", { description: "inspect", prompt: "Look around.", subagent_type: "general" })
        yield* llm.text("the child found it")
        yield* llm.text("done")

        const result = yield* vector.run("delegate a look", {
          format: "json",
          extraArgs: ["--dangerously-skip-permissions"],
        })

        expect(result.exitCode, result.stdout).toBe(0)
        const steps = vector.parseJsonEvents(result.stdout).filter((event) => event.type === "step_finish")
        const delegated = steps.filter((event) => event.subagent === true)
        expect(delegated).toHaveLength(1)
        expect((delegated[0]?.part as { sessionID?: string } | undefined)?.sessionID).not.toBe(delegated[0]?.sessionID)
        expect(steps.filter((event) => event.subagent !== true)).toHaveLength(2)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--format json records partial output for an unknown stream finish",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial json").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.fail("provider failed")
        const result = yield* vector.run("fail after output", { format: "json" })

        const events = vector.parseJsonEvents(result.stdout)
        expect(result.exitCode).toBe(0)
        expect(events.map((event) => event.type)).toEqual([
          "step_start",
          "text",
          "tool_use",
          "step_finish",
          "step_start",
          "step_finish",
        ])
        expect(events[1]?.part).toEqual(expect.objectContaining({ type: "text", text: "partial json" }))
        expect(events.at(-1)?.part).toEqual(expect.objectContaining({ type: "step-finish", reason: "unknown" }))
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects requested permissions by default and allows them with the dangerous flag",
    ({ home, llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.tool("bash", { command: "rm -f denied-file", description: "Remove a test file" })
        yield* llm.text("continued after rejection")
        const denied = yield* vector.run("request permission", { permission: { bash: "ask" } })
        vector.expectExit(denied, 0)
        expect(denied.stderr).toContain("permission requested: bash")
        expect(denied.stdout).toBe("")

        yield* llm.reset
        yield* llm.tool("bash", { command: "rm -f allowed-file", description: "Remove a test file" })
        yield* llm.text("continued after approval")
        const allowed = yield* vector.run("request permission", {
          permission: { bash: "ask" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        vector.expectExit(allowed, 0)
        expect(allowed.stderr).not.toContain("permission requested: bash")
        expect(allowed.stdout).toContain("continued after approval")

        yield* llm.reset
        yield* llm.tool("bash", { command: "touch explicitly-denied", description: "Create a denied marker" })
        yield* llm.text("continued after explicit denial")
        const explicitlyDenied = yield* vector.run("request denied permission", {
          permission: { bash: "deny" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        vector.expectExit(explicitlyDenied, 0)
        expect(explicitlyDenied.stdout).toContain("continued after explicit denial")
        expect(yield* Effect.promise(() => Bun.file(`${home}/explicitly-denied`).exists())).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "attach mode sends client-local file contents without a shared path",
    ({ home, llm, vector }) =>
      Effect.gen(function* () {
        const source = `${home}/client-only.txt`
        const sentinel = "client-only attachment sentinel"
        yield* Effect.promise(() => Bun.write(source, sentinel))
        yield* llm.text("attachment received")
        const server = yield* vector.serve()

        const result = yield* vector.run("read the attachment", {
          extraArgs: ["--attach", server.url, `--file=${source}`, "--"],
        })

        vector.expectExit(result, 0)
        const input = JSON.stringify(yield* llm.inputs)
        expect(input).toContain(sentinel)
        expect(input).not.toContain(`file://${source}`)
      }),
    60_000,
  )

  cliIt.concurrent(
    "attach mode rejects local directories before prompt admission",
    ({ home, vector }) =>
      Effect.gen(function* () {
        const result = yield* vector.run("read the directory", {
          extraArgs: ["--attach", "http://127.0.0.1:1", `--file=${home}`, "--"],
        })

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Cannot attach local directory without a shared filesystem")
      }),
    30_000,
  )

  // A background subagent reports back in a follow-up turn after the parent goes idle. The run used to exit at that
  // first idle, stopping the subagent and losing the follow-up.
  cliIt.concurrent(
    "waits for a background subagent and prints the turn that answers it before exiting",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        const toolResults = (hit: { body: Record<string, unknown> }) =>
          (Array.isArray(hit.body.messages) ? hit.body.messages : []).some(
            (message) => isRecord(message) && message.role === "tool",
          )
        const asking = (text: string) => (hit: { body: Record<string, unknown> }) => lastUserText(hit.body).includes(text)
        yield* llm.pushMatch(
          (hit) => asking("launch the survey")(hit) && !toolResults(hit),
          reply().tool("task", {
            description: "survey",
            prompt: "SURVEY_BRIEF: list the handlers.",
            subagent_type: "general",
            background: true,
          }),
        )
        yield* llm.pushMatch((hit) => asking("launch the survey")(hit) && toolResults(hit), reply().text("launched it"))
        // The subagent outlasts the parent's turn: its answer starts only once its request has waited a while.
        yield* llm.pushMatch(asking("SURVEY_BRIEF"), reply().wait(later(3_000)).text("found two handlers").stop())
        yield* llm.pushMatch(asking("task-notification"), reply().text("the survey found two handlers"))

        const result = yield* vector.run("launch the survey", {
          extraArgs: ["--dangerously-skip-permissions"],
          env: { VECTOR_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true" },
          timeoutMs: 50_000,
        })

        vector.expectExit(result, 0)
        expect(result.stdout).toBe("launched it\nthe survey found two handlers\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "stops waiting on a background subagent that shows no activity, and fails the run",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        const asking = (text: string) => (hit: { body: Record<string, unknown> }) => lastUserText(hit.body).includes(text)
        yield* llm.pushMatch(
          asking("launch the survey"),
          reply().tool("task", {
            description: "survey",
            prompt: "SURVEY_BRIEF: list the handlers.",
            subagent_type: "general",
            background: true,
          }),
        )
        yield* llm.pushMatch(asking("launch the survey"), reply().text("launched it"))
        // The subagent's provider never answers.
        yield* llm.pushMatch(asking("SURVEY_BRIEF"), reply().hang())

        const result = yield* vector.run("launch the survey", {
          extraArgs: ["--dangerously-skip-permissions"],
          env: { VECTOR_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true", VECTOR_RUN_BACKGROUND_WAIT_MS: "1000" },
          timeoutMs: 50_000,
        })

        expect(result.timedOut).toBe(false)
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).toBe("launched it\n")
        expect(result.stderr).toContain("Stopped waiting for 1 background subagent(s)")
      }),
    60_000,
  )

  cliIt.live(
    "SIGINT interrupts an active non-interactive run without leaking the process",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.hang
        const run = yield* vector.startRun("wait forever")
        yield* llm.wait(1)
        run.interrupt()
        const result = yield* run.result

        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(30_000)
      }),
    30_000,
  )
})
