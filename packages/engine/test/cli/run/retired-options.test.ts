import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

cliIt.live("unknown options print the actual argument error", ({ vector }) =>
  Effect.gen(function* () {
    const result = yield* vector.spawn(["run", "--fixture-unknown-option", "hello"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Unknown argument")
    expect(result.stderr).toContain("fixture-unknown-option")
  }),
)

cliIt.live("retired share option warns and continues the task", ({ llm, vector }) =>
  Effect.gen(function* () {
    yield* llm.text("hello")
    const result = yield* vector.run("say hello", { extraArgs: ["--share"] })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("--share is ignored")
  }),
)

cliIt.live("upgrade explains an unreachable registry without a stack trace", ({ vector, home }) =>
  Effect.gen(function* () {
    const result = yield* vector.spawn(["upgrade", "--method", "npm"], {
      env: {
        NPM_CONFIG_REGISTRY: "http://127.0.0.1:1",
        NPM_CONFIG_USERCONFIG: `${home}/missing-user.npmrc`,
        NPM_CONFIG_GLOBALCONFIG: `${home}/missing-global.npmrc`,
      },
    })
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toContain("Could not reach the configured npm registry")
    expect(result.stderr).not.toContain("Effect/successCont")
    expect(result.stderr).not.toContain("Unexpected server error")
  }),
)
