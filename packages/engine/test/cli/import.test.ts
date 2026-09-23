import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

cliIt.live("import rejects remote URLs without contacting them", ({ opencode }) =>
  Effect.gen(function* () {
    const result = yield* opencode.spawn(["import", "https://example.invalid/share/session"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("local JSON files only")
  }),
)
