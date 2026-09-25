import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt, withCliFixture } from "../lib/cli-process"
import path from "node:path"

cliIt.live("import rejects remote URLs without contacting them", ({ vector }) =>
  Effect.gen(function* () {
    const result = yield* vector.spawn(["import", "https://example.invalid/share/session"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("local JSON files only")
  }),
)

cliIt.live("local session export imports into a fresh isolated home", ({ vector, home }) =>
  Effect.gen(function* () {
    const env = { VECTOR_AGENT_DB: path.join(home, "roundtrip.db") }
    const server = yield* vector.serve({ env })
    const session = yield* Effect.promise(() =>
      fetch(`${server.url}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Round trip fixture" }),
      }).then((response) => response.json()),
    )
    const exported = yield* vector.spawn(["export", session.id], { env })
    expect(exported.exitCode, JSON.stringify(session) + exported.stderr).toBe(0)
    const file = path.join(home, "export.json")
    yield* Effect.promise(() => Bun.write(file, exported.stdout))
    yield* withCliFixture((fixture) =>
      Effect.gen(function* () {
        const env = { VECTOR_AGENT_DB: path.join(fixture.home, "roundtrip.db") }
        const before = yield* fixture.vector.spawn(["session", "list", "--format", "json"], { env })
        expect(before.exitCode, before.stderr).toBe(0)
        expect(before.stdout.trim()).toBe("")
        const imported = yield* fixture.vector.spawn(["import", file], { env })
        expect(imported.exitCode).toBe(0)
        expect(imported.stdout).toContain(session.id)
        const restored = yield* fixture.vector.spawn(["export", session.id], { env })
        expect(restored.exitCode).toBe(0)
        expect(JSON.parse(restored.stdout).info).toMatchObject({ id: session.id, title: "Round trip fixture" })
      }),
    )
  }),
)
