import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import {
  changeKeyFor,
  clearFailureMemory,
  coFailingFiles,
  failureMemoryPath,
  failureSignature,
  formatPriorGuidance,
  isFlakySignature,
  normaliseFailureOutput,
  priorFor,
  readFailureMemory,
  recordValidationRun,
} from "./failure-memory"
import type { GuardrailCheckResult, WorkspaceValidationReport } from "./workspace-guardrails"

const projects: string[] = []

async function project() {
  const dir = await mkdtemp(join(tmpdir(), "vector-failure-memory-"))
  projects.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(projects.map((dir) => rm(dir, { recursive: true, force: true })))
})

function check(id: string, status: GuardrailCheckResult["status"], output: string): GuardrailCheckResult {
  return {
    id,
    label: id === "package:typecheck" ? "Typecheck" : "Test",
    command: "bun",
    args: ["run", id.split(":")[1]!],
    reason: "deterministic check",
    status,
    exitCode: status === "failed" ? 1 : 0,
    durationMs: 1_234,
    output,
  }
}

function report(...checks: GuardrailCheckResult[]): WorkspaceValidationReport {
  return {
    startedAt: "2026-08-19T00:00:00.000Z",
    completedAt: "2026-08-19T00:00:10.000Z",
    passed: checks.every((item) => item.status !== "failed"),
    hadChecks: true,
    checks,
    failureSummary: checks
      .filter((item) => item.status === "failed")
      .map((item) => item.output)
      .join("\n\n"),
  }
}

const TS_ERROR_A = [
  "$ tsc --noEmit",
  "/Users/kb/vector/src/main/session.ts(42,17): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  "Found 1 error in src/main/session.ts:42",
].join("\n")

// The same failure seen from an isolated worktree after the agent moved the
// code down the file.
const TS_ERROR_A_AGAIN = [
  "$ tsc --noEmit",
  "/tmp/vector-ws-8f3a/src/main/session.ts(107,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  "Found 1 error in src/main/session.ts:107",
].join("\n")

const TS_ERROR_B = [
  "$ tsc --noEmit",
  "/Users/kb/vector/src/main/session.ts(42,17): error TS2551: Property 'sesion' does not exist on type 'Session'. Did you mean 'session'?",
  "Found 1 error in src/main/session.ts:42",
].join("\n")

describe("failure signature normalisation", () => {
  test("collapses the same failure across workspaces and line numbers", () => {
    expect(normaliseFailureOutput(TS_ERROR_A)).toBe(normaliseFailureOutput(TS_ERROR_A_AGAIN))
    expect(failureSignature("package:typecheck", TS_ERROR_A)).toBe(
      failureSignature("package:typecheck", TS_ERROR_A_AGAIN),
    )
  })

  test("keeps genuinely different errors apart", () => {
    expect(failureSignature("package:typecheck", TS_ERROR_A)).not.toBe(failureSignature("package:typecheck", TS_ERROR_B))
    // The same text under a different check is a different failure to repair.
    expect(failureSignature("package:typecheck", TS_ERROR_A)).not.toBe(failureSignature("package:test", TS_ERROR_A))
  })

  test("strips timestamps, ids and durations but keeps the message", () => {
    const first = normaliseFailureOutput(
      "2026-08-19T10:22:31.114Z [12:04:09] test failed after 1.42s (run 3f2b1a9c-1d4e-4a77-9b21-0d9f8c7a6b55) in 1240ms",
    )
    const second = normaliseFailureOutput(
      "2026-08-18T04:01:02.900Z [09:55:12] test failed after 12.9s (run 7c1e2b3a-9d4e-4a77-9b21-0d9f8c7a6b12) in 88ms",
    )
    expect(first).toBe(second)
    expect(first).toContain("test failed")
    expect(first).not.toContain("2026")
  })

  test("strips a known root so in-repo paths survive intact", () => {
    const normalised = normaliseFailureOutput(
      "error: /tmp/vector-ws-1/packages/desktop/src/main/index.ts:9:2 unexpected token",
      ["/tmp/vector-ws-1"],
    )
    expect(normalised).toContain("packages/desktop/src/main/index.ts")
    expect(normalised).toContain(":L:C")
  })

  test("distinguishes the same message in different files", () => {
    const one = "error: cannot find module in packages/desktop/src/main/a.ts"
    const two = "error: cannot find module in packages/desktop/src/main/b.ts"
    expect(failureSignature("package:build", one)).not.toBe(failureSignature("package:build", two))
  })
})

describe("recording runs", () => {
  test("counts occurrences of one signature and writes an inspectable file", async () => {
    const dir = await project()
    await recordValidationRun(dir, {
      report: report(check("package:typecheck", "failed", TS_ERROR_A)),
      changedFiles: ["src/main/session.ts"],
      diff: "diff-1",
    })
    const memory = await recordValidationRun(dir, {
      report: report(check("package:typecheck", "failed", TS_ERROR_A_AGAIN)),
      changedFiles: ["src/main/session.ts", "src/main/session-store.ts"],
      diff: "diff-2",
    })

    expect(memory.records).toHaveLength(1)
    expect(memory.records[0]!.occurrences).toBe(2)
    expect(memory.records[0]!.checkId).toBe("package:typecheck")
    expect(memory.records[0]!.changedFiles["src/main/session.ts"]).toBe(2)
    expect(memory.records[0]!.changedFiles["src/main/session-store.ts"]).toBe(1)
    expect(memory.records[0]!.firstSeen <= memory.records[0]!.lastSeen).toBe(true)

    const onDisk = JSON.parse(await readFile(failureMemoryPath(dir), "utf8")) as { records: unknown[] }
    expect(onDisk.records).toHaveLength(1)
  })

  test("separate failures get separate records", async () => {
    const dir = await project()
    await recordValidationRun(dir, {
      report: report(check("package:typecheck", "failed", TS_ERROR_A)),
      changedFiles: ["a.ts"],
      diff: "d1",
    })
    const memory = await recordValidationRun(dir, {
      report: report(check("package:typecheck", "failed", TS_ERROR_B)),
      changedFiles: ["a.ts"],
      diff: "d1",
    })
    expect(memory.records).toHaveLength(2)
  })
})

describe("flakiness", () => {
  test("a pass, fail, pass sequence with no file change is flaky", async () => {
    const dir = await project()
    const unchanged = { changedFiles: ["src/main/session.ts"], diff: "same-diff" }

    await recordValidationRun(dir, { report: report(check("package:test", "passed", "ok")), ...unchanged })
    await recordValidationRun(dir, {
      report: report(check("package:test", "failed", "1 fail: expected 3 to be 4 in queue.test.ts:12:9")),
      ...unchanged,
    })
    const memory = await recordValidationRun(dir, {
      report: report(check("package:test", "passed", "ok")),
      ...unchanged,
    })

    expect(memory.records).toHaveLength(1)
    expect(isFlakySignature(memory.records[0]!)).toBe(true)
    expect(memory.records[0]!.flakyPasses).toBe(1)
    expect(memory.records[0]!.repair).toBeUndefined()
  })

  test("passing after a real edit is a repair, not flakiness", async () => {
    const dir = await project()
    await recordValidationRun(dir, {
      report: report(check("package:typecheck", "failed", TS_ERROR_A)),
      changedFiles: ["src/main/session.ts"],
      diff: "before",
    })
    const memory = await recordValidationRun(dir, {
      report: report(check("package:typecheck", "passed", "ok")),
      changedFiles: ["src/main/session.ts", "src/main/types.ts"],
      diff: "after",
      repairDescription: "Widened the port argument to accept a string.",
    })

    expect(isFlakySignature(memory.records[0]!)).toBe(false)
    expect(memory.records[0]!.repair?.files).toEqual(["src/main/types.ts"])
    expect(memory.records[0]!.repair?.description).toBe("Widened the port argument to accept a string.")
  })

  test("a change key ignores file order but follows the diff", () => {
    expect(changeKeyFor(["b.ts", "a.ts"], "")).toBe(changeKeyFor(["a.ts", "b.ts"], ""))
    expect(changeKeyFor(["a.ts"], "@@ -1 +1 @@")).not.toBe(changeKeyFor(["a.ts"], "@@ -2 +2 @@"))
  })
})

describe("prior guidance", () => {
  test("surfaces a known repair for the failure at hand", async () => {
    const dir = await project()
    await recordValidationRun(dir, {
      report: report(check("package:typecheck", "failed", TS_ERROR_A)),
      changedFiles: ["src/main/session.ts"],
      diff: "before",
    })
    await recordValidationRun(dir, {
      report: report(check("package:typecheck", "passed", "ok")),
      changedFiles: ["src/main/session.ts", "src/main/types.ts"],
      diff: "after",
      repairDescription: "Widened the port argument to accept a string.",
    })

    const guidance = await priorFor(dir, report(check("package:typecheck", "failed", TS_ERROR_A_AGAIN)))
    expect(guidance).toContain("Typecheck has failed this exact way 1 time before")
    expect(guidance).toContain("src/main/types.ts")
    expect(guidance).toContain("Widened the port argument")
    expect(guidance.length).toBeLessThan(1_300)
  })

  test("warns about a flaky check instead of asking for a repair", async () => {
    const dir = await project()
    const unchanged = { changedFiles: ["queue.test.ts"], diff: "same" }
    const failing = check("package:test", "failed", "1 fail: expected 3 to be 4 in queue.test.ts:12:9")
    await recordValidationRun(dir, { report: report(failing), ...unchanged })
    await recordValidationRun(dir, { report: report(check("package:test", "passed", "ok")), ...unchanged })

    const guidance = await priorFor(dir, report(failing))
    expect(guidance).toContain("flaky")
    expect(guidance).toContain("re-run the check")
  })

  test("says nothing when the repository has never seen this failure", async () => {
    const dir = await project()
    expect(await priorFor(dir, report(check("package:typecheck", "failed", TS_ERROR_A)))).toBe("")
    expect(formatPriorGuidance({ version: 1, updatedAt: "", records: [] }, report())).toBe("")
  })
})

describe("co-failure", () => {
  test("ranks the files that keep failing together", async () => {
    const dir = await project()
    await recordValidationRun(dir, {
      report: report(check("package:typecheck", "failed", TS_ERROR_A)),
      changedFiles: ["src/a.ts", "src/b.ts"],
      diff: "1",
    })
    await recordValidationRun(dir, {
      report: report(check("package:typecheck", "failed", TS_ERROR_A_AGAIN)),
      changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      diff: "2",
    })

    expect(coFailingFiles(await readFailureMemory(dir), "src/a.ts")).toEqual(["src/b.ts", "src/c.ts"])
    expect(coFailingFiles(await readFailureMemory(dir), "src/unrelated.ts")).toEqual([])
  })
})

describe("bounds and erasure", () => {
  test("eviction bounds the store and keeps the repair that is known to work", async () => {
    const dir = await project()
    await recordValidationRun(dir, {
      report: report(check("package:typecheck", "failed", TS_ERROR_A)),
      changedFiles: ["src/main/session.ts"],
      diff: "before",
    })
    await recordValidationRun(dir, {
      report: report(check("package:typecheck", "passed", "ok")),
      changedFiles: ["src/main/session.ts", "src/main/types.ts"],
      diff: "after",
      repairDescription: "Widened the port argument to accept a string.",
    })
    const repaired = failureSignature("package:typecheck", TS_ERROR_A)

    const flood = Array.from({ length: 240 }, (_, index) =>
      check("package:test", "failed", `error TS${2000 + index}: distinct failure in module-${index}.ts`),
    )
    const memory = await recordValidationRun(dir, {
      report: report(...flood),
      changedFiles: ["src/main/flood.ts"],
      diff: "flood",
    })

    // 240 distinct signatures went in on top of the repaired one; the bound is
    // what stops a long-lived repository from accumulating them forever.
    expect(memory.records.length).toBe(200)
    expect(memory.records.some((item) => item.signature === repaired)).toBe(true)
  })

  test("clear really empties the store and removes the file", async () => {
    const dir = await project()
    await recordValidationRun(dir, {
      report: report(check("package:typecheck", "failed", TS_ERROR_A)),
      changedFiles: ["src/main/session.ts"],
      diff: "before",
    })
    expect((await readFailureMemory(dir)).records).toHaveLength(1)

    expect((await clearFailureMemory(dir)).records).toEqual([])
    expect((await readFailureMemory(dir)).records).toEqual([])
    expect(await readFile(failureMemoryPath(dir), "utf8").catch(() => "gone")).toBe("gone")
  })

  test("a corrupt store reads as empty instead of throwing", async () => {
    const dir = await project()
    await recordValidationRun(dir, {
      report: report(check("package:typecheck", "failed", TS_ERROR_A)),
      changedFiles: ["a.ts"],
      diff: "d",
    })
    await Bun.write(failureMemoryPath(dir), "{ not json")
    expect((await readFailureMemory(dir)).records).toEqual([])
  })

  test("a half-written record is repaired on read instead of crashing the repair loop", async () => {
    const dir = await project()
    await recordValidationRun(dir, {
      report: report(check("package:typecheck", "failed", TS_ERROR_A)),
      changedFiles: ["a.ts"],
      diff: "d",
    })
    // Valid JSON naming a signature but missing every field the rest of the
    // module indexes into: what an older build, a hand edit, or a merged clone
    // can leave behind.
    const stored = JSON.parse(await readFile(failureMemoryPath(dir), "utf8")) as { records: unknown[] }
    await Bun.write(
      failureMemoryPath(dir),
      JSON.stringify({
        version: 1,
        updatedAt: "2026-08-19T00:00:00.000Z",
        records: [...stored.records, { signature: "orphan", checkId: "package:test", lastOutcome: "failed" }],
      }),
    )

    const memory = await readFailureMemory(dir)
    expect(memory.records).toHaveLength(2)
    expect(memory.records[1]!.changedFiles).toEqual({})
    expect(memory.records[1]!.lastChangedFiles).toEqual([])

    // Both paths the wiring calls must survive it: guidance for an unrelated
    // failure walks every record, and a passing check writes back through it.
    expect(await priorFor(dir, report(check("package:typecheck", "failed", TS_ERROR_A)))).toContain("Typecheck")
    expect(
      (
        await recordValidationRun(dir, {
          report: report(check("package:test", "passed", "ok")),
          changedFiles: ["b.ts"],
          diff: "d2",
        })
      ).records,
    ).toHaveLength(2)
  })

  test("concurrent writes for one project do not lose records", async () => {
    const dir = await project()
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        recordValidationRun(dir, {
          report: report(check("package:test", "failed", `error: assertion ${index} failed in spec-${index}.ts`)),
          changedFiles: [`src/spec-${index}.ts`],
          diff: `d${index}`,
        }),
      ),
    )
    expect((await readFailureMemory(dir)).records).toHaveLength(8)
  })
})
