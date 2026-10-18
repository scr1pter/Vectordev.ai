import { expect, test } from "bun:test"
import path from "node:path"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { legacyName } from "@vectordevai/core/flag/legacy"
import { DEFAULT_SPEND_POLICY } from "../../desktop/src/main/spend-limits"
import summary from "../../../docs/benchmarks/vector-efficiency-2026-10/summary.json"
import manifest from "../../../docs/benchmarks/vector-efficiency-2026-10/manifest.json"

// The landing page argues that Vector is cheaper or better in some way, so every number it gives has to come from
// what ships or from the one benchmark archive checked into the repository, and everything that is not live when the
// page ships with desktop 1.99.109 has to say so.
const web = path.join(import.meta.dir, "..")
const repo = path.join(web, "../..")
const archive = path.join(repo, "docs/benchmarks/vector-efficiency-2026-10")
// Template text wraps across lines, so the copy is compared with its whitespace folded.
const read = async (file: string) => (await Bun.file(path.join(web, file)).text()).replace(/\s+/g, " ")
const lander = await read("src/components/Lander.astro")
const story = await read("src/components/marketing/LanderStory.astro")
const index = await read("src/pages/index.astro")
const footer = await read("src/components/marketing/SiteFooter.astro")
const shots = await Promise.all(
  (await Array.fromAsync(new Bun.Glob("src/components/marketing/shots/*.astro").scan({ cwd: web }))).map(
    async (file) => ({ file, text: await read(file) }),
  ),
)
const browserPanel = shots.find((shot) => shot.file.endsWith("ShotBrowserPanel.astro"))!.text
const page = [lander, story, index, footer].join("\n")

// The integrated runtime's HTTP cells: Vector on the Messages API and Claude Code, priced at the same rates.
const cells = summary.cells.filter((cell) => cell.state === "integrated" && cell.transport === "http")
const cell = (runtime: string, scenario: string, session: number) =>
  cells.find((item) => item.runtime === runtime && item.scenario === scenario && item.session === session)!
// Only tasks where both agents made the same number of requests count as the same scripted work.
const matched = Array.from(new Set(cells.map((item) => item.scenario))).filter((scenario) =>
  [1, 2].every(
    (session) => cell("vector", scenario, session).requests === cell("claude-code", scenario, session).requests,
  ),
)
const gap = (session: number) =>
  matched.map(
    (scenario) =>
      100 * (1 - cell("vector", scenario, session).costUsd / cell("claude-code", scenario, session).costUsd),
  )
const range = (values: number[]) => `${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))}%`

test("the cost figures come from the archived efficiency benchmark, against Claude Code only", () => {
  expect(matched).toEqual(["solo-fix", "delegate-explore", "delegate-general", "long-loop"])
  expect(story).toContain(
    `Vector's modelled cost was ${range(gap(1))} lower in the first session and ${range(gap(2))} lower in a second`,
  )
  expect(story).toContain(`value: "${range(gap(1))}"`)
  expect(story).toContain(`value: "${range(gap(2))}"`)
  // The hero's figure spans both sessions, and the redrawn home page in the app's browser shows the same headline.
  const both = range([...gap(1), ...gap(2)])
  expect(lander).toContain(`const heroCost = "${both}"`)
  expect(lander).toContain(
    'The same scripted work for <span class="headline-figure">{heroCost}&nbsp;less</span> modelled spend than Claude&nbsp;Code.',
  )
  expect(browserPanel).toContain(
    `The same scripted work for <span>${both} less</span> modelled spend than Claude Code.`,
  )
})

test("the first-request bar and the per-request claim come from the same archive", async () => {
  const vector = cell("vector", "solo-fix", 1)
  const claude = cell("claude-code", "solo-fix", 1)
  // A new session's first request, with nothing cached yet.
  expect([vector.firstPrimaryCacheRead, claude.firstPrimaryCacheRead]).toEqual([0, 0])
  expect(story).toContain(
    `const firstRequest = { vector: ${vector.firstPrimaryInputTokens}, claudeCode: ${claude.firstPrimaryInputTokens} }`,
  )
  expect(story).toContain(
    `Vector sent ${vector.firstPrimaryInputTokens.toLocaleString("en-US")} estimated input tokens and Claude Code ${claude.firstPrimaryInputTokens.toLocaleString("en-US")}`,
  )
  // "Each one carried less": in every repetition, every Vector request is smaller than Claude Code's at the same
  // position, and the two agents make the same number of requests.
  const reports = await Promise.all(
    [1, 2, 3].map(
      async (repetition) =>
        (await Bun.file(path.join(archive, `raw/integrated-http-${repetition}.json`)).json()) as RawReport,
    ),
  )
  const pairs = reports.flatMap((report) =>
    report.scenarios
      .filter((item) => item.runtime === "vector")
      .map((item) => ({
        vector: item.requests,
        claude: report.scenarios.find(
          (other) =>
            other.runtime === "claude-code" && other.scenario === item.scenario && other.session === item.session,
        )!.requests,
      })),
  )
  expect(pairs).toHaveLength(24)
  expect(pairs.every((pair) => pair.vector.length === pair.claude.length)).toBe(true)
  expect(
    pairs.every((pair) => pair.vector.every((request, index) => request.inputTokens < pair.claude[index].inputTokens)),
  ).toBe(true)
  expect(story).toContain("Vector made the same number of model requests as Claude Code, and each one carried less.")
  // The rates the note gives are the rates the reports priced with.
  expect(reports.every((report) => JSON.stringify(report.rates.messages) === JSON.stringify(rates))).toBe(true)
  expect(story).toContain(
    `$${rates.input} per million input tokens, $${rates.cacheWrite} for cache writes, $${rates.cacheRead.toFixed(2)} for cache reads and $${rates.output} for output`,
  )
})

test("every benchmark figure keeps its date and its caveats", () => {
  // The integrated HTTP runs all started on 11 October 2026 (UTC).
  const dates = manifest.reports
    .filter((report) => report.file.startsWith("raw/integrated-http-"))
    .map((report) => report.provenance.startedAt.slice(0, 10))
  expect(new Set(dates)).toEqual(new Set(["2026-10-11"]))
  expect(story).toContain("run 11 October 2026 against Claude Code 2.1.215")
  expect(lander).toContain("run 11 October 2026 against a fake model server and priced at list rates")
  expect(lander).toContain("It measures what each agent sends, not answer quality.")
  expect(story).toContain("not your bill")
  expect(story).toContain("It measures what each agent sends, not a live bill or answer quality.")
  expect(story).toContain(
    "The benchmark measures what each agent sends for identical scripted work, not a live bill or answer quality.",
  )
  expect(story).toContain("Each agent's simulated cache is fresh at the start of a repetition")
  expect(story).toContain("archived in Vector's repository")
  // One archive for every figure: the earlier subagent run and its numbers are gone, and so is the 10 October one.
  expect(page).not.toContain("vector-subagents-2026-10")
  expect(page).not.toMatch(/58–64%|60–67%|64–67%|68–74%|9,994|27,917/)
  // No Codex result, no general cheaper-or-faster claim, no wall time or memory.
  const numbers = story.slice(story.indexOf("const firstRequest"), story.indexOf('id: "c"'))
  expect(numbers).not.toContain("Codex")
  const proof = story.indexOf('<section id="proof"')
  expect(story.slice(proof, story.indexOf("</section>", proof))).not.toContain("Codex")
  expect(page).not.toMatch(/(cheaper|faster|leaner) than (Codex|every|any)/i)
  expect(numbers).not.toMatch(/seconds|MiB|memory|wall/i)
})

test("the hero leads with the edge, and Vector has one definition", () => {
  const definition = "a free workspace for coding agents"
  expect(index).toContain(`title="Vector — ${definition}"`)
  expect(index).toContain(`description="Vector is ${definition}`)
  expect(lander).toContain(
    `<p class="hero-deck simple-deck">Vector is ${definition}, built around a lean agent of its own.</p>`,
  )
  expect(story).toContain(`Vector is ${definition}, on your desktop and in your terminal`)
  // The closing call to action ends on the edge, not on bringing your own key.
  expect(footer).toContain(`<p class="footer-copy">Vector is ${definition}, built around a lean agent of its own.</p>`)
  expect(footer).not.toMatch(/own (model )?provider|own key/i)
  // The why-now argument says plainly why a workspace like Vector is inevitable, and keeps the harness its own.
  expect(story).toContain("That is why a workspace like Vector is inevitable")
  expect(story).not.toContain("patch format")
  expect(page).not.toMatch(/isn't a wrapper|Not a chat box|The harness shapes the bill/)
  // Adjacent sections don't repeat each other.
  expect(page.match(/each in its own copy of the repository/g)).toHaveLength(1)
  expect(story.match(/nine built-in subagents/g)).toHaveLength(1)
  expect(page.match(/within one step of the cap you set/g)).toHaveLength(1)
})

test("the Run Guard, scheduled-agent and Vectorscope figures are the ones that ship", () => {
  expect(DEFAULT_SPEND_POLICY.interactive).toEqual({})
  const perRun = DEFAULT_SPEND_POLICY.unattended.perRun?.usd
  const perDay = DEFAULT_SPEND_POLICY.unattended.perDay?.usd
  expect(story).toContain("run without a cap until you set one in Settings, Spend limits")
  expect(story).toContain(`automations start with limits of $${perRun} a run and $${perDay} a day`)
  expect(story).toContain(
    `Chats and parallel agents have no cap until you set one; automations start at $${perRun} a run and $${perDay} a day.`,
  )
  expect(story).not.toContain("Caps are off until you set one.")
  expect(SpendGuard.LOOP_REPEATS).toBe(3)
  expect(SpendGuard.ERROR_STREAK).toBe(3)
  expect(story).toContain("pauses an agent stuck repeating the same call or error three times")
  expect(story).toContain(`${SpendGuard.UNPRICED_STEPS} unpriced steps also stop a run`)
  // A spend cap is never a promise to the cent, and an unpriced step is never counted as free.
  expect(page).toContain("within one step of the cap you set")
  expect(page).not.toMatch(/\bexactly\b|never exceeds|guaranteed|holds a run to|every chat priced|prices every chat/i)
  expect(page).not.toMatch(/cost of every run|economics of every run|absolute privacy/i)
  expect(story).toContain("shows as unpriced, not as $0.00")
  // No redrawn session shows a dollar figure of zero for tokens it spent; a plan session reads as the app shows it.
  expect(shots.filter((shot) => shot.text.includes("$0.00")).map((shot) => shot.file)).toEqual([])
  expect(shots.some((shot) => shot.text.includes("<b>ChatGPT plan</b>"))).toBe(true)
  // The terminal gets the Run Guard and subagent steering with the next CLI release, not with npm CLI 1.99.99, and
  // Windows WSL servers, which keep the 1.99.99 engine, get them later still.
  expect(story).toContain("the terminal gets the Run Guard with the next CLI release")
  expect(story).toContain("Steering background subagents reaches the terminal with the next CLI release")
  expect(story.match(/Windows WSL servers/g)?.length).toBe(4)
})

test("Vector Velocity is in development, sized by its active parameters only", () => {
  expect(story).toContain('label: "Vector Velocity", status: { kind: "dev", text: "In development" }')
  expect(story).toContain("It is designed to use under 20B parameters active per token.")
  // No total size, no base model, no compute provider.
  expect(
    [page, ...shots.map((shot) => shot.text)].filter((text) =>
      /(?<![-\w.])\d+(?:B\+|B model| billion parameter)/.test(text),
    ),
  ).toEqual([])
  expect(page).not.toMatch(/\b(300|320|552)B\b|over 300/)
  expect(page).not.toMatch(/DeepSeek|GLM|Nebius/i)
  expect(page).not.toMatch(/plan to build|Velocity[^."]*\bplanned\b/i)
  expect(lander).toContain('"is building a coding model of its own."')
  // Why it matters: the comparison models' active sizes, each from its maker's own documentation, and the saving
  // stated as a design goal.
  expect(story).toContain(
    "35B parameters per token for Qwen3-Coder-480B, and 32B for Kimi K2.5 and for Cursor's Composer 2, which is built on it.",
  )
  expect(story).toContain("https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct")
  expect(story).toContain("https://huggingface.co/moonshotai/Kimi-K2.5")
  expect(story).toContain("https://arxiv.org/abs/2603.24477")
  expect(story).toContain(
    "designed to cost significantly less to run than all three. That is a design goal, not a measured result.",
  )
  expect(story).toContain("No weights or benchmarks exist yet")
})

test("what is not live when the page ships is labelled, and what ships with it is not", () => {
  // Free models on your own OpenRouter account, with may-train models labelled and a one-time question, ship in
  // desktop 1.99.109 with this page.
  expect(lander).toContain("From desktop 1.99.109, connect a free OpenRouter account")
  expect(lander).toContain("Vector asks you once before you first use a labelled one")
  expect(page).toContain("May train on your prompts")
  expect(page).not.toMatch(/Next release|With the next release|Labelled models arrive/)
  expect(page).not.toContain("Models included with Vector")
  expect(page).not.toMatch(/no matter which model|whichever model/i)
  // Codium sales are closed, and the software factory is a plan.
  expect(lander).toContain("Codium, coming soon")
  expect(story).toContain(
    'planned: "The software factory: an issue becomes a reviewed preview in the cloud with no laptop open',
  )
  // Eight is the batch size, not a limit on subagents running together, and nothing is "no cap".
  expect(lander).toContain('"runs subagents in batches of up to eight."')
  expect(page).not.toMatch(/eight subagents at once|subagents[^."]*no cap|no cap[^."]*subagents/i)
})

test("the landing page says repository, never project, for Vector's own idea", () => {
  expect([lander, story, index, footer].filter((text) => /\bprojects?\b/i.test(text))).toEqual([])
  // The redrawn sidebar, dashboard and terminal name things the way the copy does.
  const visible = shots.flatMap((shot) =>
    [
      />Projects</,
      /"Project tools"/,
      /under (Project|Repository) tools/,
      /at a project on your disk/,
      /deploys the open project/,
      /untrusted project cannot/,
      /"project policy cannot/,
      /"project MCP servers/,
    ]
      .filter((pattern) => pattern.test(shot.text))
      .map((pattern) => `${shot.file}: ${pattern}`),
  )
  expect(visible).toEqual([])
})

test("the landing page names neither the upstream project nor Cloud Services", () => {
  // The upstream name is derived from its MIT notice, so it is never written here either.
  expect(legacyName).toBeTruthy()
  expect([page, ...shots.map((shot) => shot.text)].filter((text) => text.toLowerCase().includes(legacyName!))).toEqual(
    [],
  )
  expect(page).not.toMatch(/Cloud [Ss]ervices/)
})

const rates = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 }

type RawReport = {
  rates: { messages: typeof rates }
  scenarios: { runtime: string; scenario: string; session: number; requests: { inputTokens: number }[] }[]
}
