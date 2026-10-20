import { afterAll, describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runArm, type Arm, type TaskRun } from "./harness"
import { knows, perceive } from "./policy"
import { FACTS, TASKS } from "./tasks"

// The harness against the real `vector run` and the fake model server, on four tasks: two that teach (pnpm, cents) and
// two that need what they taught. Nothing reaches the network or a real model.

const TASK_IDS = ["t01-slugify", "t02-late-fee-cents", "t07-order-discount", "t08-csv-export"]
const root = await mkdtemp(join(tmpdir(), "vector-compounding-test-"))
afterAll(() => rm(root, { recursive: true, force: true }))

const run = (arm: Arm, name: string, extra: Partial<Parameters<typeof runArm>[0]> = {}) =>
  runArm({ arm, root: join(root, name, arm.padEnd(5, "_")), tasks: TASK_IDS, dump: join(root, name, "dump"), ...extra })

// What must not change between two runs of the same build: everything but wall-clock time, memory ids, which are
// random (their length, and so their tokens, is fixed), and the token counts, which may move by a token or two where
// the test runner prints how long it took. The runs' folders have names of one length, because every request carries
// the repository's path.
const TOKENS = ["inputTokens", "outputTokens", "memoryTokens", "cacheRead", "cacheWrite", "costUsd"] as const
const stable = (runs: readonly TaskRun[]) =>
  JSON.parse(
    JSON.stringify(runs.map(({ wallMs: _, ...rest }) => Object.fromEntries(Object.entries(rest).filter(([key]) => !TOKENS.includes(key as never))))).replace(
      /\[m[0-9a-z]{5,13}\]/g,
      "[m]",
    ),
  )
const close = (a: readonly TaskRun[], b: readonly TaskRun[]) =>
  a.forEach((run, at) => expect(Math.abs(run.inputTokens - b[at]!.inputTokens)).toBeLessThanOrEqual(8))

const first = Object.fromEntries(await Promise.all((["off", "on", "blind"] as const).map(async (arm) => [arm, await run(arm, "run-1")] as const)))
const mistakes = (runs: readonly TaskRun[]) => runs.map((item) => `${item.task}:${item.mistakes.map((m) => m.fact).join(",")}`)

describe("the compounding harness", () => {
  test("every offline run follows its script and exits cleanly", () => {
    for (const runs of Object.values(first)) for (const item of runs) {
      expect(item.scriptError).toBeUndefined()
      expect(item.exitCode).toBe(0)
    }
  })

  test(
    "gives the same numbers twice",
    async () => {
      const again = Object.fromEntries(await Promise.all((["off", "on"] as const).map(async (arm) => [arm, await run(arm, "run-2")] as const)))
      expect(stable(again.off)).toEqual(stable(first.off))
      expect(stable(again.on)).toEqual(stable(first.on))
      close(again.off, first.off)
      close(again.on, first.on)
    },
    110_000,
  )

  test("brain on stops repeating what it was taught; brain off repeats it", () => {
    const repeated = (runs: readonly TaskRun[]) => runs.flatMap((item) => item.mistakes.filter((m) => m.repeated).map((m) => `${item.task}:${m.fact}`))
    expect(repeated(first.off)).toEqual(["t07-order-discount:cents", "t08-csv-export:pnpm"])
    expect(repeated(first.on)).toEqual([])
    const on = first.on.find((item) => item.task === "t08-csv-export")!
    const off = first.off.find((item) => item.task === "t08-csv-export")!
    expect(on.steps).toBeLessThan(off.steps)
    expect(on.inputTokens).toBeLessThan(off.inputTokens)
  })

  test("with recall hidden from the model, brain on loses its whole advantage", () => {
    expect(mistakes(first.blind)).toEqual(mistakes(first.off))
    expect(first.blind.map((item) => item.success)).toEqual(first.off.map((item) => item.success))
    // It still pays for memory (its tool, its saves) that brain off does not have.
    first.blind.forEach((item, at) => expect(item.steps).toBeGreaterThanOrEqual(first.off[at]!.steps))
    // The brain still ran and still cost tokens; the model just could not see what it added.
    expect(first.blind.find((item) => item.task === "t07-order-discount")!.delivered).toEqual(["cents"])
  })

  test("brain off opens no brain.db, offers no memory tool, and its requests carry no fact its prompt does not state", async () => {
    expect(first.off.flatMap((item) => item.brainFiles)).toEqual([])
    expect(first.on.at(-1)!.brainFiles.some((file) => file.endsWith(".db"))).toBe(true)
    for (const item of first.off) {
      const prompt = TASKS.find((entry) => entry.id === item.task)!.prompt
      const { requests } = JSON.parse(await readFile(join(root, "run-1", "dump", `off-${item.task}.json`), "utf8"))
      const body = requests.find((request: { body: { tools?: unknown[] } }) => request.body.tools?.length).body
      expect(body.tools.map((tool: { name: string }) => tool.name)).not.toContain("memory")
      for (const fact of FACTS) if (!fact.marker.test(prompt)) expect(knows(perceive(body), 0, fact.id)).toBe(false)
    }
  })

  test(
    "brain off ignores a full brain.db planted where Vector would look for one",
    async () => {
      // The brain-on arm's database after it learned pnpm and cents, put into every brain-off home before each task.
      const learned = first.on.at(-1)!.brainFiles
      const source = join(root, "run-1", "on___", "home")
      const planted = await run("off", "run-3", {
        beforeTask: async ({ home }) => {
          for (const file of learned) await cp(join(source, file), join(home, file), { recursive: true }).catch(() => undefined)
        },
      })
      expect(mistakes(planted)).toEqual(mistakes(first.off))
      // Untouched, its write-ahead log included: SQLite never opened it.
      expect(learned.some((name) => name.endsWith(".db"))).toBe(true)
      for (const home of ["home-01", "home-02", "home-07", "home-08"])
        for (const file of learned) {
          expect(dirname(file)).toContain("brain")
          expect(await Bun.file(join(root, "run-3", "off__", home, file)).bytes()).toEqual(await Bun.file(join(source, file)).bytes())
        }
    },
    110_000,
  )
})
