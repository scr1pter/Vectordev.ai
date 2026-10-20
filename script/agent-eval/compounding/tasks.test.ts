import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { accept, materialize } from "./harness"
import { FACTS, TASKS, apply, solve, startOf, withDependency } from "./tasks"

// The fixture has to be right before any arm is measured on it: each task's reference solution passes every hidden
// check, and the work of a model that lacks a fact fails that fact's check, so a mistake cannot go unnoticed.

// The task's start state as CI checks it out, then the work on top, with the route table regenerated or not.
async function checked(index: number, work: Record<string, string>, regenerate: boolean) {
  const start = startOf(index)
  const dir = await mkdtemp(join(tmpdir(), "vector-compounding-task-"))
  try {
    await materialize(dir, start.files, start.binary)
    for (const [path, content] of Object.entries(work)) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }
    if (regenerate) await materialize(dir, { ...start.files, ...work })
    return await accept(dir, TASKS[index]!)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("the task sequence", () => {
  test("no prompt states a fact the task needs and does not teach", () => {
    const leaks = TASKS.flatMap((task) =>
      task.needs
        .filter((id) => !task.teaches.some((item) => item.fact === id))
        .filter((id) => FACTS.find((item) => item.id === id)!.marker.test(task.prompt))
        .map((id) => `${task.id}: ${id}`),
    )
    expect(leaks).toEqual([])
  })

  test("every fact is taught before a task needs it again, and needed again at least once", () => {
    for (const item of FACTS) {
      const taught = TASKS.findIndex((task) => task.teaches.some((teach) => teach.fact === item.id))
      expect(taught).toBeGreaterThanOrEqual(0)
      expect(TASKS.slice(taught + 1).some((task) => task.needs.includes(item.id))).toBe(true)
    }
  })

  test("the sequence spans six weeks with 12 to 20 tasks", () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(12)
    expect(TASKS.length).toBeLessThanOrEqual(20)
    expect(new Set(TASKS.map((task) => task.week))).toEqual(new Set([1, 2, 3, 4, 5, 6]))
  })

  for (const [index, task] of TASKS.entries()) {
    test(
      `${task.id}: the reference solution passes, and a model without each fact it needs fails that fact's check`,
      async () => {
        const start = startOf(index)
        const reference = await checked(index, { ...solve(start.files, task) }, true)
        expect(reference.filter((item) => !item.passed).map((item) => item.name)).toEqual([])
        expect(reference.some((item) => item.name.startsWith("fact:"))).toBe(true)

        // The work of a model that knows none of the facts: the mistaken code, npm's lockfile for a dependency, and
        // no regenerated route table.
        if (task.id === "t06-flaky-session-test") return
        const unknown = apply(start.files, task.changes(start.files, () => false))
        const mistaken = task.dependency ? withDependency(unknown, task.dependency) : unknown
        const lockfile = task.dependency ? { "package-lock.json": "{}\n" } : {}
        const wrong = await checked(index, { ...mistaken, ...lockfile }, false)
        const failed = wrong.filter((item) => !item.passed).map((item) => item.name)
        for (const id of task.needs.filter((need) => !task.teaches.some((item) => item.fact === need && item.quote)))
          expect(failed).toContain(`fact:${id}`)
      },
      60_000,
    )
  }
})
