import { expect, test } from "bun:test"
import { Config, ConfigProvider, Effect, Exit } from "effect"
import { configEnv } from "../src/flag/compat"
import { it } from "./lib/effect"

it.effect("Vector configuration overrides legacy values including explicit false", () =>
  Effect.gen(function* () {
    const value = yield* configEnv("OPENCODE_PURE", Config.boolean).parse(
      ConfigProvider.fromUnknown({
        VECTOR_PURE: "false",
        OPENCODE_PURE: "true",
      }),
    )
    expect(value).toBe(false)
  }),
)

it.effect("legacy configuration remains available when the Vector name is absent", () =>
  Effect.gen(function* () {
    const value = yield* configEnv("OPENCODE_ENABLE_EXA", Config.boolean).parse(
      ConfigProvider.fromUnknown({ OPENCODE_ENABLE_EXA: "true" }),
    )
    expect(value).toBe(true)
  }),
)

it.effect("invalid Vector values cannot silently fall back to a legacy setting", () =>
  Effect.gen(function* () {
    const result = yield* configEnv("OPENCODE_PURE", Config.boolean)
      .parse(
        ConfigProvider.fromUnknown({
          VECTOR_PURE: "invalid",
          OPENCODE_PURE: "true",
        }),
      )
      .pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
  }),
)

test("environment aliases prefer new values, warn once on fallback, and never log credential contents", async () => {
  const program = `
    import { readEnv } from ${JSON.stringify(new URL("../src/flag/compat.ts", import.meta.url).href)};
    process.env.OPENCODE_AUTH_CONTENT = "placeholder-legacy";
    process.env.VECTOR_AUTH_CONTENT = "placeholder-current";
    const current = readEnv("OPENCODE_AUTH_CONTENT");
    process.env.VECTOR_AUTH_CONTENT = "";
    const empty = readEnv("OPENCODE_AUTH_CONTENT");
    delete process.env.VECTOR_AUTH_CONTENT;
    const legacy = readEnv("OPENCODE_AUTH_CONTENT");
    readEnv("OPENCODE_AUTH_CONTENT");
    process.stdout.write(JSON.stringify({ current, empty, legacy }));
  `
  const child = Bun.spawn([process.execPath, "--eval", program], { stdout: "pipe", stderr: "pipe" })
  const [output, errors] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(await child.exited).toBe(0)
  expect(JSON.parse(output)).toEqual({ current: "placeholder-current", empty: "", legacy: "placeholder-legacy" })
  expect(errors.match(/OPENCODE_AUTH_CONTENT is deprecated/g)?.length).toBe(1)
  expect(errors).not.toContain("placeholder-legacy")
  expect(errors).not.toContain("placeholder-current")
})
