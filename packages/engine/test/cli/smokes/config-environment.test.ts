import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { tmpdir } from "../../fixture/fixture"

const outsideDirectory = () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
  ).pipe(Effect.map((directory) => directory.path))

cliIt.live(
  "generic Vector observability and database variables do not configure the coding agent",
  ({ vector, home }) =>
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
    // This is an owner-controlled config, outside the untrusted workspace used as the CLI's cwd.
    const file = path.join(yield* outsideDirectory(), "agent-settings.json")
    const shell = yield* Effect.promise(() => fs.realpath(process.execPath))
    yield* Effect.promise(() => Bun.write(file, JSON.stringify({ shell, permission: { bash: "deny" } })))
    const config = yield* vector.spawn(["debug", "config"], {
      env: { VECTOR_AGENT_CONFIG: file, VECTOR_CONFIG_CONTENT: "{}" },
    })
    vector.expectExit(config, 0)
    expect(JSON.parse(config.stdout).shell).toBe(shell)
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
    yield* Effect.promise(() => Bun.write(file, JSON.stringify({ shell: process.execPath, permission: { bash: "deny" } })))
    const config = yield* vector.spawn(["debug", "config"], {
      env: { VECTOR_AGENT_CONFIG: file, VECTOR_CONFIG_CONTENT: "{}" },
    })
    vector.expectExit(config, 0)
    const parsed = JSON.parse(config.stdout)
    expect(parsed.shell).toBeUndefined()
    expect(parsed.permission?.bash).toBe("deny")
  }),
)

for (const kind of ["file", "directory"] as const) {
  cliIt.live(`an aliased project config ${kind} remains untrusted`, ({ vector, home }) =>
    Effect.gen(function* () {
      const directory = yield* outsideDirectory()
      const source = path.join(yield* Effect.promise(() => fs.realpath(home)), "project-settings")
      yield* Effect.promise(() => fs.mkdir(source))
      yield* Effect.promise(() => Bun.write(path.join(source, "project-shell"), "#!/bin/sh\nexit 0\n"))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(source, "vector.json"),
          JSON.stringify({ shell: "./project-shell", permission: { bash: "allow", edit: "deny" }, share: "disabled" }),
        ),
      )
      const alias = path.join(directory, "project-link")
      yield* Effect.promise(() => fs.symlink(source, alias, process.platform === "win32" ? "junction" : "dir"))
      const config = yield* vector.spawn(["debug", "config"], {
        env: {
          ...(kind === "file"
            ? { VECTOR_AGENT_CONFIG: path.join(alias, "vector.json") }
            : { VECTOR_AGENT_CONFIG_DIR: alias }),
          VECTOR_CONFIG_CONTENT: "{}",
        },
      })
      vector.expectExit(config, 0)
      const parsed = JSON.parse(config.stdout)
      expect(parsed.shell).toBeUndefined()
      expect(parsed.permission?.bash).not.toBe("allow")
      expect(parsed.permission?.edit).toBe("deny")
      expect(parsed.share).toBe("disabled")
    }),
  )
}
