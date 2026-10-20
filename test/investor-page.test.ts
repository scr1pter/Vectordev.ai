import { expect, test } from "bun:test"
import path from "node:path"
import { DEFAULT_REVIEW_CONFIG } from "../packages/core/src/review/types"
import { publishedDesktopVersion } from "../packages/web/src/data/vector-releases"
import summary from "../docs/benchmarks/vector-efficiency-2026-10/summary.json"

const root = path.join(import.meta.dir, "..")
const page = await Bun.file(path.join(root, "packages/web/src/pages/investors.astro")).text()
const markup = page.slice(0, page.indexOf("<style"))
const section = (pattern: RegExp) => markup.match(pattern)?.[0] ?? ""
const milestone = (title: string) =>
  section(new RegExp(`<div class="ip-milestone[^"]*">\\s*<span class="ip-stage[^"]*">[^<]+</span>\\s*<h3>${title}</h3>\\s*<p>[^<]*</p>`))

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
const saving = (scenario: string, session: number) =>
  Math.round((1 - (cell("vector", scenario, session)?.costUsd ?? 0) / (cell("claude-code", scenario, session)?.costUsd ?? 1)) * 100)
const range = (session: number) => {
  const savings = scenarios.map((scenario) => saving(scenario, session))
  if (Math.min(...savings) === Math.max(...savings)) return `${savings[0]}%`
  return `${Math.min(...savings)}–${Math.max(...savings)}%`
}

test("the one-pager stays one page", () => {
  // Visible words outside the collapsed sources list. The page is read in a couple of minutes; grow it only by
  // cutting something else. The owner added the markets section on 19 October 2026.
  const text = markup
    .slice(markup.indexOf("<div class=\"ip-page\">"))
    .replace(/<details[\s\S]*?<\/details>/g, "")
    .replace(/<[^>]+>/g, " ")
  expect(text.split(/\s+/).filter((word) => /\w/.test(word)).length).toBeLessThan(880)
  expect(markup).not.toMatch(/<table/)
})

test("the investor page quotes the efficiency archive's first- and second-session results against Claude Code", () => {
  expect(scenarios).toEqual(["solo-fix", "delegate-explore", "delegate-general"])
  expect(markup).toContain(
    `<strong class="ip-num">${range(1)}</strong><span>less modelled spend than Claude Code in a first session, offline*</span>`,
  )
  expect(markup).toContain(`a second session, run as a new process, came out ${range(2)} lower`)
  // The saving comes from what each agent sends: the archived first request of a new session, rounded to thousands.
  const thousands = (tokens: number) => `${Math.round(tokens / 1000)}K`
  expect(markup).toContain(
    `<strong class="ip-num">${thousands(cell("vector", "solo-fix", 1)?.firstPrimaryInputTokens ?? 0)}</strong><span>tokens in Vector's first request, against about ${thousands(cell("claude-code", "solo-fix", 1)?.firstPrimaryInputTokens ?? 0)} for Claude Code, offline*</span>`,
  )
  // Only spend is quoted: the archive's wall time and memory, where Claude Code wins, stay out, and so does Codex.
  expect(markup).not.toMatch(/MiB|peak memory|wall[- ]time|faster|Codex [^,]*cheaper/i)
})

test("the benchmark footnote keeps its caveats", () => {
  const method = markup.match(/<strong>\* Benchmark method\.<\/strong>([^<]*)<\/p>/)?.[1] ?? ""
  ;[
    "docs/benchmarks/vector-efficiency-2026-10",
    "an 11 October 2026 revision (commit 6f7f3c2ea)",
    "Claude Code 2.1.215",
    "identical scripted tool steps against a local fake model server",
    "the same number of model requests",
    "Medians of three repetitions",
    "$3 per million input tokens, $3.75 cache write, $0.30 cache read, $15 output",
    "characters ÷ 4",
    "not the quality of answers",
    "does not show that Vector is cheaper than other agents in general",
  ].forEach((caveat) => expect(method).toContain(caveat))
})

test("the investor page counts the built-in subagents that ship and describes Vectorscope's verify pass", async () => {
  const agents = (await Bun.file(path.join(root, "packages/engine/src/agent/agent.ts")).text())
    .split(/\n\s+name: "/)
    .slice(1)
  const subagents = agents
    .filter((agent) => agent.includes('mode: "subagent"'))
    .map((agent) => agent.slice(0, agent.indexOf('"')))
  const words = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"]
  expect(milestone("Subagent system")).toContain(`${words[subagents.length]} built-in subagents`)
  ;["explore", "review", "security", "migration"].forEach((name) => expect(subagents).toContain(name))
  expect(DEFAULT_REVIEW_CONFIG.verify).toBe("blocking")
  expect(milestone("Vectorscope")).toContain("verify pass that re-checks blocking findings")
})

test("every technology carries its status, and only the shipped ones say Today", () => {
  const items = Array.from(
    markup.matchAll(/<div class="ip-milestone[^"]*">\s*<span class="ip-stage[^"]*">([^<]+)<\/span>\s*<h3>([^<]+)<\/h3>/g),
    (match) => [match[2], match[1]],
  )
  expect(items.length).toBe(markup.match(/<div class="ip-milestone/g)?.length)
  expect(Object.fromEntries(items)).toEqual({
    "Vector Brain": "In development · 1.99.110",
    "Tokenomics engine": "Today",
    "Subagent system": "Today",
    Vectorscope: "Today",
    "Vector Velocity": "In development",
    "Vector Cloud": "Today · desktop",
    "Vector Codium": "Built in, not on sale",
  })
  // The software factory inside Vector Cloud is a plan, and many more cloud services are an intent.
  expect(milestone("Vector Cloud")).toContain("The software factory, issue to reviewed preview in the cloud, is planned.")
  expect(markup).toContain("many more cloud services of its own (intent)")
  expect(markup).not.toMatch(/next release/i)
})

// When desktop 1.99.110 is published the brain is live, so its status changes.
test.skipIf(Bun.semver.order(publishedDesktopVersion, "1.99.110") < 0)(
  "once desktop 1.99.110 is published, Vector Brain no longer says it is in development",
  async () => {
    // If the brain slipped past 1.99.110, keep the label and move the version in it instead.
    expect(await Bun.file(path.join(root, "packages/core/src/brain/brain.ts")).exists()).toBe(true)
    expect(milestone("Vector Brain")).not.toContain("In development")
    expect(markup).not.toContain("in development for desktop 1.99.110")
  },
)

test("the investor page gives Vector Velocity one status, one size, 550B parameters, and no active size, base or provider", () => {
  const velocity = milestone("Vector Velocity")
  expect(velocity).toContain("A 550B-parameter model built for Vector's own loop")
  expect(velocity).toContain("designed to cost significantly less to run than other very large coding models")
  expect(velocity).toContain("No weights or benchmarks yet")
  expect(velocity).not.toMatch(/\b(?:built on|based on|base model|fine-tun\w*|distill\w*)\b|\bGPUs?\b|\bcompute\b|credits|Nebius/i)
  expect(markup).not.toMatch(
    /\bactive (?:per token|param\w*)|parameters active|\bactivated\b|under \d+B|\d+B (?:active|per token|for every token)|parameters (?:per|for every) token|total parameters|\d+B total|billion parameters/i,
  )
  expect(new Set(Array.from(markup.matchAll(/(\d+)B-parameter/g), (match) => match[1]))).toEqual(new Set(["550"]))
  expect(markup).not.toMatch(/Velocity (is|costs|runs) (significantly )?(cheaper|less)/i)
})

test("the README gives Vector Velocity the investor page's status and size, and no active size", async () => {
  const readme = (await Bun.file(path.join(root, "README.md")).text()).match(/\*\*Vector Velocity\*\*[^\n]*/)?.[0] ?? ""
  expect(readme).toContain("**Vector Velocity** (In development): Vector's own 550B-parameter model")
  expect(readme).toContain("there are no weights or benchmarks yet")
  expect(readme).not.toMatch(/Planned|No work on it has started|active|under \d+B|\d+B\+|\d+ billion|total parameters|\d+B total/i)
})

test("the brain is labelled wherever the page opens with it", () => {
  // The lede is what investors read first, so the brain's status sits in it too, not only in its card.
  expect(markup).toContain("Its brain, in development for desktop 1.99.110, learns each repository it works in")
  expect(page).toContain("a brain that learns each repository and a model of its own, both in development")
})

test("the markets the brain serves are labelled as not yet products, and say what the brain does, not how", () => {
  const markets = section(/<section class="ip-section" aria-labelledby="markets-title">[\s\S]*?<\/section>/)
  expect(markets).toContain("None of these is a separate product or on sale yet.")
  expect(markets.match(/<div class="ip-reason">/g)).toHaveLength(6)
  // How the brain checks documents against code stays off the public page.
  expect(markup).not.toMatch(/\bdrift|mismatch|spec says|datasheet says|code says/i)
})

test("the investor page names the outside agents Vector runs and the business it plans", () => {
  expect(markup).not.toMatch(/every (lab's|vendor's) agent|any vendor's agents/i)
  expect(markup).toContain("its own lean agent beside Claude Code, Codex and Cursor Agent")
  ;["$10", "$50", "$100", "$200"].forEach((price) => expect(markup).toContain(`<b>${price}</b>`))
  expect(markup).not.toMatch(/markup/i)
})

test("the investor page keeps to the owner's wording and disclosure rules", () => {
  expect(markup).not.toMatch(/\bexactly\b|never exceeds|absolute privacy|no matter which model/i)
  expect(markup).not.toMatch(/\bprojects?\b/i)
  // Any privacy line must hold after free models that may train on prompts arrive.
  expect(markup).toContain("Vector itself never trains on prompts or code")
  expect(markup).not.toMatch(/No-training free models|prompts are not used for training/)
  // No contact address, team, traction or raise figures.
  expect(markup).not.toMatch(/mailto:|@vectordev\.ai|\bARR\b|\bMRR\b|pre-money|founder/i)
})
