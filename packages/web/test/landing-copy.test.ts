import { expect, test } from "bun:test"
import path from "node:path"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { DEFAULT_REVIEW_CONFIG } from "@vectordevai/core/review/types"
import { DEFAULT_SPEND_POLICY } from "../../desktop/src/main/spend-limits"

// The landing page argues that Vector is cheaper or better in some way, so every number it gives has to come from
// what ships or from a benchmark checked into the repository, and everything that is not live yet has to say so.
const web = path.join(import.meta.dir, "..")
const repo = path.join(web, "../..")
// Template text wraps across lines, so the copy is compared with its whitespace folded.
const read = async (file: string) => (await Bun.file(path.join(web, file)).text()).replace(/\s+/g, " ")
const lander = await read("src/components/Lander.astro")
const story = await read("src/components/marketing/LanderStory.astro")
const index = await read("src/pages/index.astro")
const shots = await Promise.all(
  (await Array.fromAsync(new Bun.Glob("src/components/marketing/shots/*.astro").scan({ cwd: web }))).map(
    async (file) => ({ file, text: await read(file) }),
  ),
)
const page = [lander, story, index].join("\n")

test("the cost figures come from the archived subagent benchmark", async () => {
  // Vector's cells are the final reports; Claude Code's are the matching attempt-1 cells (see the archive README).
  const archive = path.join(repo, "docs/benchmarks/vector-subagents-2026-10")
  const cell = async (file: string, runtime: string) =>
    ((await Bun.file(path.join(archive, file)).json()) as { scenarios: Cell[] }).scenarios.filter(
      (item) => item.runtime === runtime,
    )
  const pairs = await Promise.all(
    ["explore", "general", "multi", "dependency", "steer", "stop"].map(async (name) => ({
      name,
      vector: await cell(`final-${name}-attempt-2.json`, "vector"),
      claude: await cell(`candidate-${name}-attempt-1.json`, "claude-code"),
    })),
  )
  const session = (cells: Cell[], number: number) => cells.find((item) => item.session === number)!
  expect(pairs.flatMap((pair) => [...pair.vector, ...pair.claude]).every((item) => item.valid)).toBe(true)
  // Only scenarios where both agents made the same number of requests are quoted.
  const matched = pairs.filter((pair) => session(pair.vector, 1).totals.requests === session(pair.claude, 1).totals.requests)
  const gap = (number: number) =>
    matched.map(
      (pair) => 100 * (1 - session(pair.vector, number).totals.costUsd / session(pair.claude, number).totals.costUsd),
    )
  const range = (values: number[]) => `${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))}%`
  expect(matched).toHaveLength(5)
  expect(story).toContain(`Vector's modelled cost was ${range(gap(1))} lower in the first session and ${range(gap(2))} lower in a second.`)
  expect(story).toContain(`value: "${range(gap(1))}"`)
  expect(story).toContain(`${range(gap(1))} lower modelled cost than Claude Code 2.1.215 on five scripted subagent tasks`)
  const left = pairs.filter((pair) => !matched.includes(pair))
  expect(left.map((pair) => pair.name)).toEqual(["steer"])
  expect(story).toContain(
    `Vector made ${session(left[0].vector, 1).totals.requests} requests to Claude Code's ${session(left[0].claude, 1).totals.requests}`,
  )
  // The archive's first request is the same size the 17 October run measured on the release code.
  expect(session(pairs[0].vector, 1).totals.firstRequest.inputTokens).toBe(10091)
})

test("every benchmark figure keeps its date and its caveats", () => {
  expect(story).toContain("9,994 against 27,917 estimated tokens")
  expect(story).toContain("run 17 October 2026")
  expect(story).toContain("run 16 October 2026")
  expect(story).toContain("Codex was not part of them.")
  expect(story).toContain("not your bill")
  expect(story).toContain("Not a live bill or a measure of answer quality")
  expect(lander).toContain("offline, 17 Oct 2026")
  // The 10 October figure rested on a scenario that read a missing file.
  expect(page).not.toMatch(/58–64%|60–67%/)
  expect(page).not.toMatch(/(cheaper|faster|leaner) than (Codex|every|any)/i)
})

test("the Run Guard, scheduled-agent and Vectorscope figures are the ones that ship", () => {
  expect(DEFAULT_SPEND_POLICY.interactive).toEqual({})
  expect(story).toContain("run without a cap until you set one in Settings, Spend limits")
  expect(story).toContain("Caps are off until you set one.")
  expect(story).toContain(
    `automations start with limits of $${DEFAULT_SPEND_POLICY.unattended.perRun?.usd} a run and $${DEFAULT_SPEND_POLICY.unattended.perDay?.usd} a day`,
  )
  expect(SpendGuard.LOOP_REPEATS).toBe(3)
  expect(SpendGuard.ERROR_STREAK).toBe(3)
  expect(story).toContain("pauses an agent stuck repeating the same call or error three times")
  expect(story).toContain(`${SpendGuard.UNPRICED_STEPS} unpriced steps also stop a run`)
  expect(story).toContain(
    `a $${DEFAULT_REVIEW_CONFIG.maxCostUsd.toFixed(2)} cap for one review and $${DEFAULT_REVIEW_CONFIG.maxCostUsdPerPr.toFixed(2)} across the automatic reviews of one pull request`,
  )
  expect(story).toContain(`value: "$${DEFAULT_REVIEW_CONFIG.maxCostUsd} · $${DEFAULT_REVIEW_CONFIG.maxCostUsdPerPr}"`)
  // A spend cap is never a promise to the cent.
  expect(page).toContain("within one step of the cap you set")
  expect(page).not.toMatch(/\bexactly\b|never exceeds|guaranteed/i)
  // The terminal gets the Run Guard and subagent steering with the next CLI release, not with npm CLI 1.99.99.
  expect(story).toContain("the terminal gets the Run Guard with the next CLI release")
  expect(story).toContain("Steering background subagents reaches the terminal with the next CLI release.")
})

test("what is not live yet is labelled", () => {
  // Vector Velocity: no work has started, so it is Planned, never coming or in development, and over 300B.
  expect(story).toContain("over 300B parameters (300B+)")
  expect(story).toContain('label: "Vector Velocity", status: { kind: "planned", text: "Planned" }')
  expect(page).not.toMatch(/Velocity[^.]*\b(coming|in development|400B)\b/i)
  expect(lander).not.toMatch(/model coming/)
  // Free models whose providers may train arrive with the next release, behind a label and a one-time question.
  expect(story).toContain("Free models inside of Vector")
  expect(story).toContain("labelled “May train on your prompts”, and Vector asks you once before you first use one")
  expect(lander).toContain("Labelled models arrive with the next release, and Vector asks you once before you first use one.")
  expect(page).not.toContain("Models included with Vector")
  expect(page).not.toMatch(/no matter which model|whichever model/i)
  // Codium sales are closed, and the software factory is a plan.
  expect(story).toContain('kind: "soon", text: "Coming soon"')
  expect(lander).toContain("Codium, coming soon")
  expect(story).toContain(
    'planned: "The software factory: an issue becomes a reviewed preview in the cloud with no laptop open',
  )
  // Subagents run up to eight per batch; only parallel agents are uncapped.
  expect(lander).toContain('"runs up to eight subagents at once."')
  expect(page).not.toMatch(/subagents[^."]*no cap|no cap[^."]*subagents/i)
})

test("the landing page says repository, never project, for Vector's own idea", () => {
  expect([lander, story, index].filter((text) => /\bprojects?\b/i.test(text))).toEqual([])
  // The redrawn sidebar and dashboard name the groups the way the copy does.
  const visible = shots.flatMap((shot) =>
    [/>Projects</, /"Project tools"/, /under Project tools/, /at a project on your disk/, /deploys the open project/]
      .filter((pattern) => pattern.test(shot.text))
      .map((pattern) => `${shot.file}: ${pattern}`),
  )
  expect(visible).toEqual([])
})

test("the landing page names neither the upstream project nor Cloud Services", () => {
  expect([page, ...shots.map((shot) => shot.text)].filter((text) => /opencode/i.test(text))).toEqual([])
  expect(page).not.toMatch(/Cloud [Ss]ervices/)
})

type Cell = {
  runtime: string
  session: number
  valid: boolean
  totals: { requests: number; costUsd: number; firstRequest: { inputTokens: number } }
}
