import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Live mode up to the point where it would call a model: no case here passes --yes, so nothing is run and no key is
// used. A paid provider without prices is refused, because its spend would count as $0 and the cap would never stop it.

const root = await mkdtemp(join(tmpdir(), "vector-compounding-run-"))
afterAll(() => rm(root, { recursive: true, force: true }))

async function live(name: string, args: readonly string[]) {
  const work = join(root, name)
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "run.ts"), "--live", "--work", work, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: root, FAKE_KEY: "not-a-key" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  return { exitCode, stderr, made: existsSync(work) }
}

describe("live mode before it starts", () => {
  test("refuses a paid provider without prices, before it makes any folder", async () => {
    const anthropic = await live("anthropic", ["--provider", "anthropic", "--model", "claude-sonnet-4-5", "--api-key-env", "FAKE_KEY", "--max-spend", "20"])
    expect(anthropic.exitCode).toBe(2)
    expect(anthropic.stderr).toContain("give --price-input and --price-output")
    expect(anthropic.made).toBe(false)
    const remote = await live("remote", ["--provider", "openai-compatible", "--base-url", "https://openrouter.ai/api/v1", "--model", "m", "--api-key-env", "FAKE_KEY"])
    expect(remote.exitCode).toBe(2)
    expect(remote.stderr).toContain("is not an endpoint on this machine")
    // One price is not enough.
    const half = await live("half", ["--provider", "openai", "--model", "m", "--api-key-env", "FAKE_KEY", "--price-input", "2"])
    expect(half.exitCode).toBe(2)
  })

  test("a local endpoint may run unpriced, and the estimate says the cap then limits nothing", async () => {
    const local = await live("local", ["--provider", "openai-compatible", "--base-url", "http://127.0.0.1:8000/v1", "--model", "m"])
    expect(local.exitCode).toBe(0)
    expect(local.stderr).toContain("every step counts as $0 and the spend cap limits nothing")
    expect(local.stderr).toContain("Nothing was run. Add --yes to start.")
    expect(local.made).toBe(false)
  })

  test("a priced provider gets an estimate, a cap counted from reported tokens, and the shell warning", async () => {
    const priced = await live("priced", [
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet-4-5",
      "--api-key-env",
      "FAKE_KEY",
      "--price-input",
      "3",
      "--price-output",
      "15",
      "--max-spend",
      "20",
    ])
    expect(priced.exitCode).toBe(0)
    expect(priced.stderr).toMatch(/Estimated cost: \$\d+\.\d\d to \$\d+\.\d\d/)
    expect(priced.stderr).toContain("counted from the tokens the provider reports at these prices")
    expect(priced.stderr).toContain("Run this inside a container or a throwaway machine.")
    expect(priced.made).toBe(false)
  })

  test("never runs in CI", async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "run.ts"), "--live", "--provider", "anthropic", "--model", "m"], {
      env: { PATH: process.env.PATH ?? "", HOME: root, CI: "1" },
      stderr: "pipe",
    })
    expect(await child.exited).toBe(2)
    expect(await new Response(child.stderr).text()).toContain("never runs in CI")
  })
})
