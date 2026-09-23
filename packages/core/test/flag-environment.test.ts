import { expect, test } from "bun:test"
import { Config, ConfigProvider, Effect, Exit } from "effect"
import { configEnv } from "../src/flag/compat"
import { it } from "./lib/effect"

it.effect("Vector configuration preserves explicit false", () =>
  Effect.gen(function* () {
    const value = yield* configEnv("VECTOR_PURE", Config.boolean).parse(
      ConfigProvider.fromUnknown({ VECTOR_PURE: "false", UNRELATED_PURE: "true" }),
    )
    expect(value).toBe(false)
  }),
)

it.effect("unrelated configuration is never used as a fallback", () =>
  Effect.gen(function* () {
    const result = yield* configEnv("VECTOR_PURE", Config.boolean)
      .parse(ConfigProvider.fromUnknown({ UNRELATED_PURE: "true" }))
      .pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
  }),
)

it.effect("invalid Vector configuration fails", () =>
  Effect.gen(function* () {
    const result = yield* configEnv("VECTOR_PURE", Config.boolean)
      .parse(ConfigProvider.fromUnknown({ VECTOR_PURE: "invalid" }))
      .pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
  }),
)

test("environment reads preserve empty values and never log credentials", async () => {
  const program = `
    import { readEnv } from ${JSON.stringify(new URL("../src/flag/compat.ts", import.meta.url).href)};
    process.env.UNRELATED_AUTH_CONTENT = "unrelated-placeholder";
    process.env.VECTOR_AUTH_CONTENT = "current-placeholder";
    const current = readEnv("VECTOR_AUTH_CONTENT");
    process.env.VECTOR_AUTH_CONTENT = "";
    const empty = readEnv("VECTOR_AUTH_CONTENT");
    delete process.env.VECTOR_AUTH_CONTENT;
    const missing = readEnv("VECTOR_AUTH_CONTENT") === undefined;
    process.stdout.write(JSON.stringify({ current, empty, missing }));
  `
  const child = Bun.spawn([process.execPath, "--eval", program], { stdout: "pipe", stderr: "pipe" })
  const [output, errors] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(await child.exited).toBe(0)
  expect(JSON.parse(output)).toEqual({ current: "current-placeholder", empty: "", missing: true })
  expect(errors).toBe("")
})
