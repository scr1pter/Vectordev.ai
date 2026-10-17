import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

// Far more than a pipe holds (64 KB at most), so most of the output is still queued in the CLI when
// the command finishes and the CLI reaches its exit.
const prompt = "x".repeat(160_000)
const env = { VECTOR_CONFIG_CONTENT: JSON.stringify({ agent: { big: { prompt } } }) }

cliIt.live(
  "piped output larger than the pipe buffer all reaches a reader that starts late",
  ({ vector }) =>
    Effect.gen(function* () {
      // `vector debug config | (sleep 3; cat)`. Three seconds is past the CLI's startup on a fast
      // machine and inside the five seconds the CLI waits at exit for a pipe to drain.
      const result = yield* vector.pipe(
        ["debug", "config"],
        [process.execPath, "-e", "await Bun.sleep(3000); await Bun.write(Bun.stdout, await Bun.stdin.bytes())"],
        { env },
      )
      vector.expectExit(result, 0, "vector debug config | late reader")
      expect(result.stdout.length).toBeGreaterThan(prompt.length)
      // The command prints JSON.stringify(config, null, 2) and a newline, so a complete copy reprints exactly.
      expect(result.stdout).toBe(JSON.stringify(JSON.parse(result.stdout), null, 2) + "\n")
      expect(JSON.parse(result.stdout).agent.big.prompt).toBe(prompt)
    }),
  60_000,
)

cliIt.live(
  "piped output to a reader that has already exited does not hold the CLI open",
  ({ vector }) =>
    Effect.gen(function* () {
      // `vector debug config | true`: the reader is gone before the CLI writes, so every write fails.
      // The pipeline only finishes once the CLI has exited too.
      const result = yield* vector.pipe(["debug", "config"], [process.execPath, "-e", "process.exit(0)"], { env })
      expect(result.timedOut).toBeFalsy()
      vector.expectExit(result, 0, "vector debug config | exited reader")
    }),
  60_000,
)
