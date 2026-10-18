import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("vector models --accept-training and --decline-training", () => {
  cliIt.live(
    "write and remove the one acceptance the desktop engine also reads",
    ({ vector, home }) =>
      Effect.gen(function* () {
        // The fixed path every engine on this computer reads, whatever its XDG_STATE_HOME.
        const file = path.join(home, ".local", "state", "vector", "free-model-training-consent.json")
        // The desktop engine's state directory sits inside the app's data folder; a terminal started with that
        // environment must still write the shared file.
        const desktop = {
          XDG_STATE_HOME: path.join(home, "Library", "Application Support", "ai.vector.app", "xdg-state"),
        }
        const accepted = yield* vector.spawn(["models", "--accept-training"], { env: desktop })
        vector.expectExit(accepted, 0, "models --accept-training")
        expect(accepted.stdout + accepted.stderr).toContain(
          'Accepted. Free models labelled "May train on your prompts"',
        )
        expect(yield* Effect.promise(() => Bun.file(file).json())).toMatchObject({ version: 1, training: true })
        const declined = yield* vector.spawn(["models", "--decline-training"])
        vector.expectExit(declined, 0, "models --decline-training")
        expect(declined.stdout + declined.stderr).toContain("Withdrawn.")
        expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
        // Both at once is refused, and records nothing.
        const both = yield* vector.spawn(["models", "--accept-training", "--decline-training"])
        expect(both.exitCode).not.toBe(0)
        expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
      }),
    90_000,
  )
})
