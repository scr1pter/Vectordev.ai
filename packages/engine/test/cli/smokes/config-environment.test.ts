import { expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

cliIt.live("generic Vector observability and database variables do not configure the coding agent", ({ vector, home }) =>
  Effect.gen(function* () {
    const pipeline = path.join(home, "pipeline.yaml")
    yield* Effect.promise(() => Bun.write(pipeline, "sources:\n  input:\n    type: stdin\n"))
    const config = yield* vector.spawn(["debug", "config"], {
      env: { VECTOR_CONFIG: pipeline, VECTOR_CONFIG_DIR: pipeline, VECTOR_DB: "chroma" },
    })
    vector.expectExit(config, 0)
    expect(config.stderr).not.toContain("ConfigInvalid")
    const sessions = yield* vector.spawn(["session", "list"], { env: { VECTOR_DB: "chroma" } })
    vector.expectExit(sessions, 0)
    expect(yield* Effect.promise(() => Bun.file(path.join(home, ".local/share/vector/chroma")).exists())).toBe(false)
  }),
)

cliIt.live("distinctive agent config and database variables are honored", ({ vector, home }) =>
  Effect.gen(function* () {
    // The CLI runs inside `home`, which makes a file there project config. The user's own file lives elsewhere.
    const outside = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "vector-agent-config-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    )
    const file = path.join(outside, "agent-settings.json")
    yield* Effect.promise(() => Bun.write(file, JSON.stringify({ shell: "/fixture/shell", permission: { bash: "deny" } })))
    const config = yield* vector.spawn(["debug", "config"], {
      env: { VECTOR_AGENT_CONFIG: file, VECTOR_CONFIG_CONTENT: "{}" },
    })
    vector.expectExit(config, 0)
    expect(config.stdout).toContain("/fixture/shell")
    expect(config.stdout).toContain('"bash": "deny"')
    const database = path.join(home, "agent-sessions.db")
    const sessions = yield* vector.spawn(["session", "list"], { env: { VECTOR_AGENT_DB: database } })
    vector.expectExit(sessions, 0)
    expect(yield* Effect.promise(() => Bun.file(database).exists())).toBe(true)
  }),
)

cliIt.live("an agent config file inside an untrusted project cannot set the shell", ({ vector, home }) =>
  Effect.gen(function* () {
    const file = path.join(home, "agent-settings.json")
    yield* Effect.promise(() => Bun.write(file, JSON.stringify({ shell: "/fixture/shell", permission: { bash: "deny" } })))
    const config = yield* vector.spawn(["debug", "config"], {
      env: { VECTOR_AGENT_CONFIG: file, VECTOR_CONFIG_CONTENT: "{}" },
    })
    vector.expectExit(config, 0)
    expect(config.stdout).not.toContain("/fixture/shell")
    // A project may still narrow what the agent can do.
    expect(config.stdout).toContain('"bash": "deny"')
  }),
)
