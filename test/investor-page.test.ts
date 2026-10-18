import { expect, test } from "bun:test"
import path from "node:path"
import { DEFAULT_REVIEW_CONFIG } from "../packages/core/src/review/types"
import { DEFAULT_SPEND_POLICY } from "../packages/desktop/src/main/spend-limits"
import { publishedDesktopVersion, release199 } from "../packages/web/src/data/vector-releases"
import summary from "../docs/benchmarks/vector-efficiency-2026-10/summary.json"

const root = path.join(import.meta.dir, "..")
const page = await Bun.file(path.join(root, "packages/web/src/pages/investors.astro")).text()
const section = (pattern: RegExp) => page.match(pattern)?.[0] ?? ""

// The page quotes one benchmark: the integrated HTTP cells of the checked-in efficiency archive, Vector on the Messages
// API against Claude Code, priced at the same rates.
const cell = (runtime: string, scenario: string, session: number) =>
  summary.cells.find(
    (item) =>
      item.state === "integrated" &&
      item.transport === "http" &&
      item.runtime === runtime &&
      item.scenario === scenario &&
      item.session === session,
  )
// long-loop is left out: at every harness revision in the archive it scripts a read of src/args.ts, which its fixture
// (discipline-single-file-fix, with src/parse-args.ts) does not have, so both agents get an error result for that step.
const scenarios = Array.from(new Set(summary.cells.map((item) => item.scenario))).filter(
  (scenario) =>
    scenario !== "long-loop" &&
    [1, 2].every(
      (session) => cell("vector", scenario, session)?.requests === cell("claude-code", scenario, session)?.requests,
    ),
)
const pair = (scenario: string, session: number) => ({
  vector: cell("vector", scenario, session)?.costUsd ?? 0,
  claude: cell("claude-code", scenario, session)?.costUsd ?? 0,
})
const saving = (costs: { vector: number; claude: number }) => Math.round((1 - costs.vector / costs.claude) * 100)
const range = (session: number) => {
  const savings = scenarios.map((scenario) => saving(pair(scenario, session)))
  if (Math.min(...savings) === Math.max(...savings)) return `${savings[0]}%`
  return `${Math.min(...savings)}–${Math.max(...savings)}%`
}

test("the investor page gives the default spend caps that ship, and only for scheduled agents", () => {
  // Parallel agents are checked against the interactive policy, which ships with no caps. If either default changes,
  // the stage line that describes them must change with it.
  expect(DEFAULT_SPEND_POLICY.interactive).toEqual({})
  expect(page).toContain(
    `scheduled agents stop at $${DEFAULT_SPEND_POLICY.unattended.perRun?.usd} a run and $${DEFAULT_SPEND_POLICY.unattended.perDay?.usd} a day by default`,
  )
  expect(page).not.toMatch(/parallel agents[^.]*stop at \$/i)
})

test("the investor page says interactive spend caps shipped in desktop 1.99.108 and stay off until set", () => {
  // The Run Guard shipped in desktop 1.99.108, and the interactive policy still ships with no caps, so the page calls
  // them opt-in. A default interactive cap, or a rollback of the published desktop version, makes these lines untrue.
  expect(Bun.semver.order(publishedDesktopVersion, "1.99.108")).toBeGreaterThanOrEqual(0)
  expect(release199.find((release) => release.version === "1.99.108")?.summary).toContain(
    "The Run Guard caps what one run spends: set it in Settings, Spend limits.",
  )
  expect(page).toContain(
    "<strong>Spend caps are opt-in.</strong> Desktop 1.99.108 holds interactive runs to a live cap only once you set one",
  )
  // Spend limits are moving to one overall limit, so the page names no per-repository budget.
  expect(page).not.toContain("budget.run")
  // The Run Guard can overshoot by one step for each running agent, not one step in all.
  const notes = release199.find((release) => release.version === "1.99.108")?.summary ?? ""
  expect(notes).toContain("within one step for each agent running")
  expect(page).toContain("the Run Guard stops a run at your cap, within one step for each agent running")
  expect(page).not.toMatch(/within one step of a cap/)
  // WSL servers and the 1.99.99 CLI do not have these controls yet.
  expect(notes).toContain("project trust, the Run Guard, loop pauses and the new subagent controls do not apply yet")
  expect(page).toContain(
    "on a Windows WSL server and in the 1.99.99 CLI the Run Guard, repository trust and the new subagent controls do not apply yet",
  )
})

test("the investor page counts and names the built-in subagents that ship", async () => {
  const agents = (await Bun.file(path.join(root, "packages/engine/src/agent/agent.ts")).text())
    .split(/\n\s+name: "/)
    .slice(1)
  const subagents = agents
    .filter((agent) => agent.includes('mode: "subagent"'))
    .map((agent) => agent.slice(0, agent.indexOf('"')))
  expect(subagents).toContain("general")
  expect(page).toContain(`${subagents.length} built in: ${subagents.join(", ")};`)
})

test("the investor page quotes the efficiency archive's first- and second-session ranges against Claude Code", () => {
  expect(scenarios).toEqual(["solo-fix", "delegate-explore", "delegate-general"])
  expect(page).not.toContain('id: "long-loop"')
  const first = range(1)
  const second = range(2)
  expect(page).toContain(
    `<strong class="ip-num">${first}</strong><span>less modelled spend than Claude Code in a first session, offline*</span>`,
  )
  expect(page).toContain(
    `<h2 id="bench-title"><span class="ip-big ip-num">${first}</span> less modelled spend than Claude Code in a first session*</h2>`,
  )
  expect(page).toContain(`<b class="ip-num">${second}</b> less in a second session, with the simulated cache warm.`)
  // The bars are drawn from these costs, so each row must carry the archived medians for both sessions.
  expect(
    Array.from(
      page.matchAll(
        /\{ id: "([\w-]+)", label: "[^"]+", first: \{ vector: ([\d.]+), claude: ([\d.]+) \}, second: \{ vector: ([\d.]+), claude: ([\d.]+) \} \}/g,
      ),
      (match) => match.slice(1),
    ),
  ).toEqual(
    scenarios.map((scenario) => [
      scenario,
      ...[1, 2].flatMap((session) => [String(pair(scenario, session).vector), String(pair(scenario, session).claude)]),
    ]),
  )
  const requests = scenarios.map((scenario) => cell("vector", scenario, 1)?.requests ?? 0)
  expect(page).toContain(`${Math.min(...requests)} to ${Math.max(...requests)} in the scripted tasks above`)
  const thousands = (tokens: number) => (Math.round(tokens / 1000) * 1000).toLocaleString("en-US")
  // The archived revision predates desktop 1.99.108 and the shipped first request differs from it, so the size is
  // given as the archived run's, in the past tense.
  expect(page).toContain(
    `in the archived run, Vector's first request in a new session was about ${thousands(cell("vector", "solo-fix", 1)?.firstPrimaryInputTokens ?? 0)} tokens, Claude Code's about ${thousands(cell("claude-code", "solo-fix", 1)?.firstPrimaryInputTokens ?? 0)}.`,
  )
  // Modelled offline spend is not a bill anyone pays today, and the uncommitted 17 October run is not quoted.
  expect(page).not.toMatch(/bills[^.]*today|own keys today/)
  expect(page).not.toContain("vector-footprint-2026-10-17")
})

test("the benchmark footnote keeps its caveats, and the benchmark names no other agent or timing", () => {
  const method = page.match(/<strong>\* Benchmark method\.<\/strong>([^<]*)<\/p>/)?.[1] ?? ""
  const caveats = [
    "docs/benchmarks/vector-efficiency-2026-10",
    "Claude Code 2.1.215",
    "identical scripted tool steps against a local fake model server",
    "the same number of model requests",
    "$3 per million input tokens, $3.75 cache write, $0.30 cache read, $15 output",
    "characters ÷ 4",
    "simulated cache is fresh at the start of a repetition",
    "not the quality of answers",
    "does not show that Vector is cheaper than other agents in general",
  ]
  caveats.forEach((caveat) => expect(method).toContain(caveat))
  // The figures are from an 11 October revision that desktop 1.99.108 includes, not a measurement of the release, the
  // cache carries across tasks, and the left-out task is named.
  expect(method).toContain("an 11 October 2026 revision (commit 6f7f3c2ea)")
  expect(method).toContain(
    "Desktop 1.99.108 includes this revision plus later changes; this archive does not measure the release itself.",
  )
  expect(method).toContain("so only the bug-fix task's first session starts with an empty cache")
  expect(method).toContain("its script reads a file that does not exist")
  expect(method).not.toContain("which desktop 1.99.108 includes")
  const bench = section(/<section class="ip-section ip-bench"[\s\S]*?<\/section>/)
  expect(bench).toContain("Claude Code 2.1.215")
  expect(bench).not.toContain("Codex")
  expect(method).not.toContain("Codex")
  // Only spend is quoted: the archive's wall time and memory, where Claude Code wins, stay out.
  expect(page).not.toMatch(/MiB|peak memory|wall[- ]time|faster/i)
  // The comparison grid names no Codex price beside Vector's free workspace.
  expect(page).not.toMatch(/\$20\/mo/)
  expect(page).toContain('["y", "@codex review, on paid plans"]')
})

test("the investor page describes Vectorscope's default verify pass", () => {
  expect(DEFAULT_REVIEW_CONFIG.verify).toBe("blocking")
  expect(page).toContain("verify pass that re-checks blocking findings")
})

test("the investor page gives Vector Velocity one status, one active size and no total, base or provider", () => {
  expect(page.match(/<span class="ip-stage">In development<\/span>\s*<h3>Vector Velocity<\/h3>/g)).toHaveLength(2)
  expect(page).toContain('<b class="ip-num">Under 20B</b> parameters active per token, by design')
  const sizes = Array.from(page.matchAll(/under (\d+)B/gi), (match) => Number(match[1]))
  expect(sizes.length).toBeGreaterThan(3)
  expect(new Set(sizes)).toEqual(new Set([20]))
  expect(page).not.toMatch(/total parameters|\d+B total|billion parameters|\bover \d{3}B?\b|no work has started|Not started/i)
  const velocity = [
    section(/<div class="ip-vcard">[\s\S]*?<\/ul>/),
    section(/<tr class="ip-four-v">[\s\S]*?<\/tr>/),
    section(/<span class="ip-stage">In development<\/span>\s*<h3>Vector Velocity<\/h3>\s*<p>[^<]*<\/p>/),
  ]
  velocity.forEach((part) => {
    expect(part).not.toBe("")
    expect(part).not.toMatch(/\b(?:built on|based on|base model|fine-tun\w*|distill\w*)\b|\bGPUs?\b|\bcompute\b|credits/i)
  })
  expect(page).toContain("Work has started; there are no weights or benchmarks yet")
  expect(page).toContain(
    "specialised for agentic computer use, agentic workflows and Vector's own harness, plus other coding and developer-tool tasks",
  )
  // The neutral harness and the own model are one argument: any model runs, and Velocity is one more choice.
  expect(page).toContain("Vector runs any model the developer picks.")
  // The picker already has free and local models, so Velocity is compared only with the very large coding models.
  expect(page).toContain(
    "one more choice in the picker, designed to cost significantly less to run than the very large coding models",
  )
  expect(page).not.toMatch(/price lowest|lowest[- ]priced|cheapest/i)
  // Codium steps count as unpriced on the dollar meter, so Velocity is not said to sell on it.
  expect(page).not.toMatch(/on that meter|already has the meter/i)
})

test("the README gives Vector Velocity the investor page's status and active size, and no total", async () => {
  // The landing page (Lander.astro, ShotBrowserPanel.astro) is rewritten for desktop 1.99.109 on its own branch, so
  // only the README, which the page's footnote points readers to, is held to the page here.
  const readme = (await Bun.file(path.join(root, "README.md")).text()).match(/\*\*Vector Velocity\*\*[^\n]*/)?.[0] ?? ""
  expect(readme).toContain("**Vector Velocity** (In development)")
  expect(readme).toContain("under 20B parameters active per token")
  expect(readme).toContain("there are no weights or benchmarks yet")
  expect(readme).not.toMatch(/Planned|No work on it has started|\d+B\+|\d+ billion|total parameters|\d+B total/i)
  expect(page).toContain('<b class="ip-num">Under 20B</b> parameters active per token')
})

test("the investor page compares Velocity with one set of four models and one per-token range", () => {
  const large = Array.from(page.matchAll(/\{ name: "([^"]+)", maker: "[^"]+", active: (\d+), fromBase/g), (match) => ({
    name: match[1],
    active: Number(match[2]),
  }))
  expect(large.map((model) => model.name)).toEqual(["Qwen3-Coder-480B-A35B", "Composer 2.5", "SWE-2", "Kimi K2.7 Code"])
  // Each runs more parameters per token than Velocity is designed to.
  expect(large.filter((model) => model.active < 20)).toEqual([])
  const span = `${Math.min(...large.map((model) => model.active))}B to ${Math.max(...large.map((model) => model.active))}B`
  expect(page).toContain(`Four very large coding models run ${span} parameters for every token`)
  expect(page).toContain(`Velocity is designed for under 20B against their ${span}`)
  expect(page).not.toMatch(/four largest|21–35B/)
  // There are no weights, so the page can only say what Velocity is designed to do.
  expect(page).toContain("Designed to cost significantly less to run than all four")
  expect(page).not.toMatch(/Velocity (is|costs|runs) (significantly )?(cheaper|less)/i)
})

test("the investor page says Vector runs three outside agents and answers the platform-risk question", () => {
  expect(page).not.toMatch(/every (lab's|vendor's) agent|any vendor's agents/i)
  expect(page).toContain("its own lean agent beside Claude Code, Codex and Cursor Agent")
  expect(page).toContain("<h3>And if a lab cuts Vector off?</h3>")
  // The external-agents docs are the source for how the outside CLIs run.
  expect(page).toContain("It runs each vendor's own CLI, installed and signed in by the developer")
})

test("the investor page labels every roadmap item and every revenue line that does not exist yet", () => {
  const roadmap = section(/<section class="ip-section" aria-labelledby="roadmap-title">[\s\S]*?<\/section>/)
  const labels = Array.from(
    roadmap.matchAll(/<div class="ip-milestone[^"]*">\s*<span class="ip-stage[^"]*">([^<]+)<\/span>/g),
    (match) => match[1],
  )
  expect(labels).toHaveLength(roadmap.match(/<div class="ip-milestone/g)?.length ?? 0)
  expect(new Set(labels)).toEqual(new Set(["Built in, not on sale", "In development", "Planned", "Intent"]))
  expect(roadmap).toMatch(/<span class="ip-stage ip-intent">Intent<\/span>\s*<h3>Many more cloud services<\/h3>/)
  expect(roadmap).toContain("Vector intends to build many more cloud services of its own")
  // Codium ships in desktop 1.99.108 with sales switched on server-side once payments are connected, so no desktop
  // release opens them.
  expect(release199.find((release) => release.version === "1.99.108")?.summary).toContain(
    "Vector Codium is built in for when sales open",
  )
  expect(roadmap).toMatch(/<span class="ip-stage">Built in, not on sale<\/span>\s*<h3>Vector Codium<\/h3>/)
  expect(page).not.toMatch(/next release/i)
  // Vector Cloud's Vercel and Supabase controls shipped; only the software factory in it is planned.
  expect(roadmap).toMatch(/<span class="ip-stage">Planned<\/span>\s*<h3>The software factory, in Vector Cloud<\/h3>/)
  expect(page).not.toMatch(/Vector Cloud\s*(·|\()\s*planned/i)
  // Issue-to-PR runs on a GitHub Actions runner, not in the desktop app.
  expect(page).toContain("and issue-to-PR in the repository's GitHub Actions")
  // The flywheel uses the roadmap's labels, in the same order; Why invest states the edge instead of repeating them.
  ;[
    "<b>Free workspace · Today</b>",
    "<b>Codium credits · Built in, not on sale</b>",
    "<b>Vector Velocity · In development</b>",
    "<b>Cloud software factory · Planned</b>",
    "many more cloud services of Vector's own (intent)",
  ].forEach((line) => expect(page).toContain(line))
  ;["$10", "$50", "$100", "$200"].forEach((price) => expect(page).toContain(`<b>${price}</b>`))
  expect(page).not.toMatch(/markup/i)
})

test("the investor page keeps to the owner's wording and disclosure rules", () => {
  expect(page).not.toMatch(/\bexactly\b|never exceeds|absolute privacy|no matter which model/i)
  expect(page).not.toMatch(/\bprojects?\b/i)
  // Any privacy line must hold after free models that may train on prompts arrive.
  expect(page).toContain("Vector itself never trains on prompts or code")
  expect(page).not.toMatch(/No-training free models|prompts are not used for training/)
  // No contact address, team, traction or raise figures.
  expect(page).not.toMatch(/mailto:|@vectordev\.ai|\bARR\b|\bMRR\b|pre-money|founder/i)
})
