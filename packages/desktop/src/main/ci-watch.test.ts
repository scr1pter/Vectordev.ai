import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { buildRepairPrompt, ciStatus, detectCiRepo, listCiRuns, parseFailureLog, type CiFailure } from "./ci-watch"

// Real `gh run view --log-failed` output: "<job>\t<step>\t<ISO timestamp> <line>".
const TSC_LOG = [
  "typecheck\tRun bun typecheck\t2026-08-19T11:04:02.1200000Z ##[group]Run bun typecheck",
  "typecheck\tRun bun typecheck\t2026-08-19T11:04:02.1200000Z bun typecheck",
  "typecheck\tRun bun typecheck\t2026-08-19T11:04:02.1200000Z shell: /usr/bin/bash -e {0}",
  "typecheck\tRun bun typecheck\t2026-08-19T11:04:02.1200000Z ##[endgroup]",
  "typecheck\tRun bun typecheck\t2026-08-19T11:04:03.4000000Z $ tsgo -b",
  "typecheck\tRun bun typecheck\t2026-08-19T11:04:09.9000000Z src/main/ci-watch.ts(84,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "typecheck\tRun bun typecheck\t2026-08-19T11:04:09.9000000Z src/main/ipc.ts(212,3): error TS2554: Expected 2 arguments, but got 1.",
  "typecheck\tRun bun typecheck\t2026-08-19T11:04:10.0000000Z Found 2 errors in 2 files.",
  "typecheck\tRun bun typecheck\t2026-08-19T11:04:10.1000000Z ##[error]Process completed with exit code 2.",
].join("\n")

const BUN_TEST_LOG = [
  "test\tRun bun test\t2026-08-19T11:05:01.0000000Z ##[group]Run cd packages/desktop",
  "test\tRun bun test\t2026-08-19T11:05:01.0000000Z cd packages/desktop",
  "test\tRun bun test\t2026-08-19T11:05:01.0000000Z bun test src/main",
  "test\tRun bun test\t2026-08-19T11:05:01.0000000Z shell: /usr/bin/bash -e {0}",
  "test\tRun bun test\t2026-08-19T11:05:01.0000000Z ##[endgroup]",
  "test\tRun bun test\t2026-08-19T11:05:02.0000000Z bun test v1.2.19 (aad3abea)",
  "test\tRun bun test\t2026-08-19T11:05:02.0000000Z ",
  "test\tRun bun test\t2026-08-19T11:05:02.5000000Z src/main/ci-watch.test.ts:",
  "test\tRun bun test\t2026-08-19T11:05:02.6000000Z (pass) parseFailureLog > reads a tsc block [1.20ms]",
  "test\tRun bun test\t2026-08-19T11:05:02.7000000Z (fail) parseFailureLog > reads an oxlint block [0.80ms]",
  "test\tRun bun test\t2026-08-19T11:05:02.7000000Z error: expect(received).toBe(expected)",
  'test\tRun bun test\t2026-08-19T11:05:02.7000000Z Expected: "lint"',
  'test\tRun bun test\t2026-08-19T11:05:02.7000000Z Received: "unknown"',
  "test\tRun bun test\t2026-08-19T11:05:03.0000000Z  1 pass",
  "test\tRun bun test\t2026-08-19T11:05:03.0000000Z  1 fail",
  "test\tRun bun test\t2026-08-19T11:05:03.1000000Z ##[error]Process completed with exit code 1.",
].join("\n")

// Doubles as the redaction fixture: the offending line holds a token-shaped
// string that must never reach a model or the UI.
const OXLINT_LOG = [
  "lint\tRun bun lint\t2026-08-19T11:06:00.0000000Z ##[group]Run bun lint",
  "lint\tRun bun lint\t2026-08-19T11:06:00.0000000Z bun lint",
  "lint\tRun bun lint\t2026-08-19T11:06:00.0000000Z shell: /usr/bin/bash -e {0}",
  "lint\tRun bun lint\t2026-08-19T11:06:00.0000000Z ##[endgroup]",
  "lint\tRun bun lint\t2026-08-19T11:06:01.0000000Z $ oxlint --deny-warnings packages/desktop/src",
  "lint\tRun bun lint\t2026-08-19T11:06:02.0000000Z   \u001B[31m×\u001B[0m eslint(no-unused-vars): Variable 'staleKey' is declared but never used.",
  "lint\tRun bun lint\t2026-08-19T11:06:02.0000000Z    ╭─[packages/desktop/src/main/ci-watch.ts:12:7]",
  'lint\tRun bun lint\t2026-08-19T11:06:02.0000000Z 12 │ const staleKey = "ghp_0123456789abcdefghijklmnopqrstuvwx"',
  "lint\tRun bun lint\t2026-08-19T11:06:02.0000000Z    ╰────",
  "lint\tRun bun lint\t2026-08-19T11:06:03.0000000Z Found 0 warnings and 1 error.",
  "lint\tRun bun lint\t2026-08-19T11:06:03.1000000Z ##[error]Process completed with exit code 1.",
].join("\n")

const MAKE_LOG = [
  "build\tRun make release\t2026-08-19T11:07:00.0000000Z ##[group]Run make release",
  "build\tRun make release\t2026-08-19T11:07:00.0000000Z make release",
  "build\tRun make release\t2026-08-19T11:07:00.0000000Z shell: /usr/bin/bash -e {0}",
  "build\tRun make release\t2026-08-19T11:07:00.0000000Z env:",
  "build\tRun make release\t2026-08-19T11:07:00.0000000Z   NODE_ENV: production",
  "build\tRun make release\t2026-08-19T11:07:00.0000000Z ##[endgroup]",
  "build\tRun make release\t2026-08-19T11:07:04.0000000Z cc -c src/main.c -o build/main.o",
  "build\tRun make release\t2026-08-19T11:07:06.0000000Z src/main.c:14: undefined reference to `render'",
  "build\tRun make release\t2026-08-19T11:07:06.0000000Z make: *** [release] Error 1",
  "build\tRun make release\t2026-08-19T11:07:06.1000000Z ##[error]Process completed with exit code 1.",
  "",
].join("\n")

describe("parseFailureLog", () => {
  test("reads a tsc type error block", () => {
    const steps = parseFailureLog(TSC_LOG)
    expect(steps).toHaveLength(1)
    expect(steps[0].job).toBe("typecheck")
    expect(steps[0].step).toBe("Run bun typecheck")
    expect(steps[0].kind).toBe("type-error")
    expect(steps[0].command).toBe("bun typecheck")
    expect(steps[0].exitCode).toBe(2)
    expect(steps[0].excerpt).toContain("error TS2322: Type 'string' is not assignable to type 'number'.")
    expect(steps[0].excerpt).toContain("Found 2 errors in 2 files.")
    // The Actions timestamp and the step preamble are noise to the agent.
    expect(steps[0].excerpt).not.toContain("2026-08-19T11:04")
    expect(steps[0].excerpt).not.toContain("##[group]")
  })

  test("reads a bun test failure and keeps the failing case", () => {
    const steps = parseFailureLog(BUN_TEST_LOG)
    expect(steps).toHaveLength(1)
    expect(steps[0].kind).toBe("test-failure")
    expect(steps[0].exitCode).toBe(1)
    // A multi-line `run:` script is echoed in full under the group header.
    expect(steps[0].command).toBe("cd packages/desktop\nbun test src/main")
    expect(steps[0].excerpt).toContain("(fail) parseFailureLog > reads an oxlint block")
    expect(steps[0].excerpt).toContain("expect(received).toBe(expected)")
    expect(steps[0].excerpt).toContain("1 fail")
  })

  test("reads an oxlint block through its ANSI colouring", () => {
    const steps = parseFailureLog(OXLINT_LOG)
    expect(steps).toHaveLength(1)
    expect(steps[0].kind).toBe("lint")
    expect(steps[0].command).toBe("bun lint")
    expect(steps[0].excerpt).toContain("eslint(no-unused-vars): Variable 'staleKey' is declared but never used.")
    expect(steps[0].excerpt).toContain("Found 0 warnings and 1 error.")
    expect(steps[0].excerpt).not.toContain("\u001B[31m")
  })

  test("redacts a token-shaped string before the excerpt can leave the process", () => {
    const steps = parseFailureLog(OXLINT_LOG)
    expect(steps[0].excerpt).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwx")
    expect(steps[0].excerpt).toContain("[REDACTED]")
  })

  test("falls back to the exit code when no tool output is recognisable", () => {
    const steps = parseFailureLog(MAKE_LOG)
    expect(steps).toHaveLength(1)
    expect(steps[0].kind).toBe("exit-code")
    expect(steps[0].exitCode).toBe(1)
    expect(steps[0].command).toBe("make release")
    expect(steps[0].excerpt).toContain("undefined reference to `render'")
    expect(steps[0].excerpt).toContain("make: *** [release] Error 1")
  })

  test("keeps one record per job and step, in log order", () => {
    const steps = parseFailureLog([TSC_LOG, OXLINT_LOG, MAKE_LOG].join("\n"))
    expect(steps.map((step) => step.job)).toEqual(["typecheck", "lint", "build"])
    expect(steps.map((step) => step.kind)).toEqual(["type-error", "lint", "exit-code"])
  })

  test("still parses a log that carries no job or step prefix", () => {
    const steps = parseFailureLog(["$ bun test", "(fail) session > restores [2.00ms]", " 1 fail"].join("\n"))
    expect(steps).toHaveLength(1)
    expect(steps[0].job).toBe("")
    expect(steps[0].kind).toBe("test-failure")
    expect(steps[0].excerpt).toContain("(fail) session > restores")
  })

  test("caps a huge step while keeping both the first error and the summary", () => {
    const filler = Array.from({ length: 400 }, (_, index) => `note: rebuilding module ${index} of 400`)
    const log = [
      "##[group]Run bun typecheck",
      "bun typecheck",
      "shell: /usr/bin/bash -e {0}",
      "##[endgroup]",
      "src/a.ts(1,1): error TS2322: the first failure",
      ...filler,
      "src/z.ts(9,9): error TS2554: the last failure",
      "Found 402 errors in 3 files.",
    ]
      .map((line) => `typecheck\tRun bun typecheck\t2026-08-19T11:04:02.1200000Z ${line}`)
      .join("\n")
    const steps = parseFailureLog(log, { maxExcerptBytes: 600 })
    expect(Buffer.byteLength(steps[0].excerpt)).toBeLessThanOrEqual(600)
    expect(steps[0].excerpt).toContain("error TS2322: the first failure")
    expect(steps[0].excerpt).toContain("Found 402 errors in 3 files.")
    expect(steps[0].excerpt).toContain("log lines trimmed")
  })

  // Redaction runs after the clamp and can make a line longer, so the cap has to
  // survive a log made entirely of lines that grow when redacted.
  test("holds the excerpt cap even when redaction lengthens every line it keeps", () => {
    const log = [" 1 fail", ...Array.from({ length: 5000 }, () => "password: b")]
      .map((line) => `test\tRun bun test\t2026-08-19T11:05:01.0000000Z ${line}`)
      .join("\n")
    expect(Buffer.byteLength(parseFailureLog(log, { maxExcerptBytes: 600 })[0].excerpt)).toBeLessThanOrEqual(600)
    expect(Buffer.byteLength(parseFailureLog(log)[0].excerpt)).toBeLessThanOrEqual(8 * 1024)
  })

  // A workflow that hardcodes a token in its `run:` block echoes it into the log,
  // and the command is quoted into the repair prompt verbatim.
  test("redacts the echoed command, not just the excerpt", () => {
    const log = [
      '##[group]Run curl -H "Authorization: Bearer ghp_0123456789abcdefghijklmnopqrstuvwx" https://api.example.com',
      'curl -H "Authorization: Bearer ghp_0123456789abcdefghijklmnopqrstuvwx" https://api.example.com',
      "shell: /usr/bin/bash -e {0}",
      "##[endgroup]",
      "##[error]Process completed with exit code 1.",
    ]
      .map((line) => `deploy\tRun curl\t2026-08-19T11:04:02.1200000Z ${line}`)
      .join("\n")
    const steps = parseFailureLog(log)
    expect(steps[0].command).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwx")
    expect(steps[0].command).toContain("[REDACTED]")
    expect(steps[0].command).toContain("curl")
  })
})

describe("buildRepairPrompt", () => {
  const failure: CiFailure = {
    repo: "vectordev/vector",
    run: {
      id: 91234,
      number: 412,
      workflow: "CI",
      title: "fix(desktop): keep a restorable copy",
      branch: "ci-watch",
      headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      event: "push",
      status: "completed",
      conclusion: "failure",
      url: "https://github.com/vectordev/vector/actions/runs/91234",
      createdAt: "2026-08-19T11:04:00Z",
    },
    steps: parseFailureLog(TSC_LOG),
    logTruncated: false,
  }

  test("carries the command, the excerpt, and an order to reproduce first", () => {
    const prompt = buildRepairPrompt(failure)
    expect(prompt).toContain("bun typecheck")
    expect(prompt).toContain("error TS2322: Type 'string' is not assignable to type 'number'.")
    expect(prompt).toContain("https://github.com/vectordev/vector/actions/runs/91234")
    expect(prompt).toContain("typecheck > Run bun typecheck")
    expect(prompt).toContain("exit code 2")
    expect(prompt).toContain("FIRST reproduce it locally")
    expect(prompt.indexOf("FIRST reproduce it locally")).toBeGreaterThan(prompt.indexOf("error TS2322"))
    expect(prompt).toContain("Never delete, skip, or weaken a test")
  })

  test("says so rather than inventing a command when the log recorded none", () => {
    const prompt = buildRepairPrompt({
      ...failure,
      steps: [{ job: "deploy", step: "Publish", kind: "unknown", excerpt: "" }],
    })
    expect(prompt).toContain("Command: the log did not record one.")
    expect(prompt).toContain("Log excerpt: GitHub returned no log for this step.")
  })
})

describe("unavailable environments", () => {
  test("reports gh as missing instead of throwing when it is not on PATH", async () => {
    const original = process.env.PATH ?? ""
    process.env.PATH = "/nonexistent-vector-ci-watch"
    const status = await ciStatus(process.cwd())
    const runs = await listCiRuns(process.cwd())
    process.env.PATH = original
    expect(status.ok).toBe(false)
    expect(runs.ok).toBe(false)
    if (status.ok || runs.ok) throw new Error("gh should not have been resolvable")
    expect(status.reason).toBe("gh-missing")
    expect(status.command.length).toBeGreaterThan(0)
    expect(runs.reason).toBe("gh-missing")
  })

  test("names the command that adds a remote when the repo has none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vector-ci-watch-"))
    await Bun.spawn(["git", "init", "-q"], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited
    const detected = await detectCiRepo(dir)
    await rm(dir, { recursive: true, force: true })
    expect(detected.ok).toBe(false)
    if (detected.ok) throw new Error("a fresh repo has no origin")
    expect(detected.reason).toBe("no-remote")
    expect(detected.command).toContain("git remote add origin")
  })

  test("reports a folder that is not a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vector-ci-watch-"))
    const detected = await detectCiRepo(dir)
    await rm(dir, { recursive: true, force: true })
    expect(detected.ok).toBe(false)
    if (detected.ok) throw new Error("an empty folder is not a repository")
    expect(detected.reason).toBe("not-a-repo")
    expect(detected.command).toBe("git init")
  })
})
