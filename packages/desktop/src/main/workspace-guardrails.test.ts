import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateWorkspace } from "./workspace-guardrails"

const root = await mkdtemp(join(tmpdir(), "vector-guardrails-"))
afterAll(() => rm(root, { recursive: true, force: true }))

async function project(name: string, typecheck: string) {
  const directory = join(root, name)
  await Bun.write(join(directory, "package.json"), JSON.stringify({ name, scripts: { typecheck } }))
  await writeFile(join(directory, "bun.lock"), "")
  return directory
}

test("a check that fails is reported as failed", async () => {
  const report = await validateWorkspace(await project("failing", "exit 3"))
  expect(report.checks.map((check) => check.status)).toEqual(["failed"])
  expect(report.passed).toBe(false)
})

// cmd.exe runs package scripts on Windows and reports a missing local tool this way, where a POSIX shell exits 127.
test("a check whose tool is missing from the workspace on Windows is skipped, not failed", async () => {
  const report = await validateWorkspace(
    await project(
      "windows-missing-tool",
      `echo "'tsc' is not recognized as an internal or external command," && exit 1`,
    ),
  )
  expect(report.checks.map((check) => check.status)).toEqual(["skipped"])
  expect(report.passed).toBe(true)
})
