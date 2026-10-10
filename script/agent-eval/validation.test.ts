import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { taskById, type EvalTask } from "./tasks"
import { validateTask } from "./validation"

async function fixture(task: EvalTask, run: (input: { root: string; agentDir: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vector-grading-test-"))
  const agentDir = join(root, "agent")
  await Promise.all(
    Object.entries(task.files).map(async ([path, content]) => {
      await mkdir(dirname(join(agentDir, path)), { recursive: true })
      await writeFile(join(agentDir, path), content)
    }),
  )
  try {
    await run({ root, agentDir })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function invoiceTask() {
  const task = taskById("bugfix-overdue-invoices")
  if (!task) throw new Error("Invoice task is missing")
  return task
}

function durationTask() {
  const task = taskById("test-writing-parse-duration")
  if (!task) throw new Error("Duration task is missing")
  return { ...task, mutations: task.mutations.slice(0, 1) }
}

test("grading cannot be made to pass by edited evaluator tests or a Bun preload", async () => {
  const task = invoiceTask()
  await fixture(task, async (input) => {
    await writeFile(
      join(input.agentDir, "test/invoice.test.ts"),
      'import { test } from "bun:test"\ntest("fake pass", () => {})\n',
    )
    await writeFile(join(input.agentDir, "bunfig.toml"), '[test]\npreload = ["./src/preload.ts"]\n')
    await writeFile(
      join(input.agentDir, "src/preload.ts"),
      `await Bun.write(${JSON.stringify(join(input.root, "preload-ran"))}, "yes"); process.exit(0)\n`,
    )
    const result = await validateTask({ task, ...input, timeoutMs: 2_000 })
    expect(result.error).toBeUndefined()
    expect(result.checkExitCode).toBe(1)
    expect(result.protectedViolations).toContain("test/invoice.test.ts")
    expect(result.protectedViolations).toContain("bunfig.toml")
    expect(await Bun.file(join(input.root, "preload-ran")).exists()).toBe(false)
  })
})

test("grading copies added helper source files, even outside expectedFiles", async () => {
  const task = invoiceTask()
  await fixture(task, async (input) => {
    await writeFile(
      join(input.agentDir, "src/overdue.ts"),
      "export const isOverdue = (dueOn: string, today: string) => dueOn < today\n",
    )
    await writeFile(
      join(input.agentDir, "src/invoice.ts"),
      `import { isOverdue } from "./overdue"\n${task.files["src/invoice.ts"].replace("invoice.dueOn <= today", "isOverdue(invoice.dueOn, today)")}`,
    )
    const result = await validateTask({ task, ...input, timeoutMs: 2_000 })
    expect(result.error).toBeUndefined()
    expect(result.checkExitCode).toBe(0)
    expect(result.protectedViolations).toEqual([])
    expect(result.assertionFailures).toEqual([])
  })
})

test("deleted infrastructure stays pristine for checking and invalidates the submitted artifact", async () => {
  const task = invoiceTask()
  await fixture(task, async (input) => {
    await rm(join(input.agentDir, "package.json"))
    await writeFile(join(input.agentDir, "src/invoice.ts"), task.files["src/invoice.ts"].replace("<= today", "< today"))
    const result = await validateTask({ task, ...input, timeoutMs: 2_000 })
    expect(result.checkExitCode).toBe(0)
    expect(result.protectedViolations).toEqual(["package.json"])
  })
})

test("file symlinks are rejected and their targets never execute in grading", async () => {
  const task = invoiceTask()
  await fixture(task, async (input) => {
    await writeFile(join(input.root, "outside.ts"), 'throw new Error("OUTSIDE_SYMLINK_EXECUTED")\n')
    await rm(join(input.agentDir, "src/invoice.ts"))
    await symlink(join(input.root, "outside.ts"), join(input.agentDir, "src/invoice.ts"))
    const result = await validateTask({ task, ...input, timeoutMs: 2_000 })
    expect(result.checkExitCode).toBe(1)
    expect(result.protectedViolations).toContain("src/invoice.ts (symlink)")
    expect(result.output).not.toContain("OUTSIDE_SYMLINK_EXECUTED")
  })
})

test("directory symlinks are rejected without traversing the target", async () => {
  const task = invoiceTask()
  await fixture(task, async (input) => {
    await mkdir(join(input.root, "outside"))
    await writeFile(join(input.root, "outside/invoice.ts"), task.files["src/invoice.ts"].replace("<= today", "< today"))
    await rm(join(input.agentDir, "src"), { recursive: true })
    await symlink(join(input.root, "outside"), join(input.agentDir, "src"))
    const result = await validateTask({ task, ...input, timeoutMs: 2_000 })
    expect(result.checkExitCode).toBe(1)
    expect(result.protectedViolations).toContain("src (symlink)")
  })
})

test("test additions cannot change non-test-writing checks", async () => {
  const task = invoiceTask()
  await fixture(task, async (input) => {
    await writeFile(join(input.agentDir, "test/override.test.ts"), "process.exit(0)\n")
    const result = await validateTask({ task, ...input, timeoutMs: 2_000 })
    expect(result.checkExitCode).toBe(1)
    expect(result.protectedViolations).toContain("test/override.test.ts")
  })
})

test("runtime scratch metadata is excluded without invalidating the artifact", async () => {
  const task = invoiceTask()
  await fixture(task, async (input) => {
    await mkdir(join(input.agentDir, ".vector"))
    await writeFile(join(input.agentDir, ".vector/bunfig.toml"), "not evaluator configuration")
    await writeFile(join(input.agentDir, "src/invoice.ts"), task.files["src/invoice.ts"].replace("<= today", "< today"))
    const result = await validateTask({ task, ...input, timeoutMs: 2_000 })
    expect(result.checkExitCode).toBe(0)
    expect(result.protectedViolations).toEqual([])
  })
})

test("an implementation that terminates Bun before its tests run cannot pass", async () => {
  const task = invoiceTask()
  await fixture(task, async (input) => {
    await writeFile(join(input.agentDir, "src/invoice.ts"), `process.exit(0)\n${task.files["src/invoice.ts"]}`)
    const result = await validateTask({ task, ...input, timeoutMs: 2_000 })
    expect(result.checkExitCode).toBe(1)
    expect(result.output).toContain("without a completed passing test suite")
  })
})

test("a hanging mutation check is not credited as a detected defect", async () => {
  const task = durationTask()
  await fixture(task, async (input) => {
    await mkdir(join(input.agentDir, "test"))
    await writeFile(
      join(input.agentDir, "test/duration.test.ts"),
      `import { expect, test } from "bun:test"
import { parseDuration } from "../src/duration"
test("seconds are exact", async () => {
  const duration = parseDuration("1s")
  if (duration !== 1000) await Bun.sleep(10_000)
  expect(duration).toBe(1000)
})
`,
    )
    const result = await validateTask({ task, ...input, timeoutMs: 150 })
    expect(result.checkExitCode).toBe(0)
    expect(result.mutationsCaught).toBe(0)
    expect(result.output).toContain("seconds-unit: not caught; check timed out")
  })
})

test("a mutation with a failing registered assertion receives credit", async () => {
  const task = durationTask()
  await fixture(task, async (input) => {
    await mkdir(join(input.agentDir, "test"))
    await writeFile(
      join(input.agentDir, "test/duration.test.ts"),
      `import { expect, test } from "bun:test"
import { parseDuration } from "../src/duration"
test("seconds are exact", () => expect(parseDuration("1s")).toBe(1000))
`,
    )
    const result = await validateTask({ task, ...input, timeoutMs: 2_000 })
    expect(result.checkExitCode).toBe(0)
    expect(result.mutationsCaught).toBe(1)
    expect(result.output).toContain("seconds-unit: caught by failing test")
  })
})

test("a mutation that breaks test imports receives no assertion credit", async () => {
  const task = {
    ...durationTask(),
    mutations: [{ id: "invalid-source", path: "src/duration.ts", find: "s: 1000,", replace: "s: { invalid syntax," }],
  }
  await fixture(task, async (input) => {
    await mkdir(join(input.agentDir, "test"))
    await writeFile(
      join(input.agentDir, "test/duration.test.ts"),
      `import { expect, test } from "bun:test"
import { parseDuration } from "../src/duration"
test("seconds are exact", () => expect(parseDuration("1s")).toBe(1000))
`,
    )
    const result = await validateTask({ task, ...input, timeoutMs: 2_000 })
    expect(result.checkExitCode).toBe(0)
    expect(result.mutationsCaught).toBe(0)
  })
})

test("grading setup errors are returned as diagnostics", async () => {
  const task = invoiceTask()
  await fixture(task, async (input) => {
    const result = await validateTask({
      task,
      agentDir: input.agentDir,
      root: join(input.root, "missing-parent"),
      timeoutMs: 2_000,
    })
    expect(result.checkExitCode).toBe(127)
    expect(result.error).toContain("ENOENT")
    expect(result.mutationsCaught).toBe(0)
  })
})
