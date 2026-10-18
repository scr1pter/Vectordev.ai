import { expect, test } from "bun:test"
import path from "node:path"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { legacyName } from "@vectordevai/core/flag/legacy"
import { DEFAULT_SPEND_POLICY } from "../../desktop/src/main/spend-limits"
import { publishedDesktopVersion } from "../src/data/vector-releases"
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
// Only tasks where both agents made the same number of requests count as the same scripted work. long-loop is left
// out: its script reads a file the fixture does not have, so it is not a valid task.
const matched = Array.from(new Set(cells.map((item) => item.scenario))).filter(
  (scenario) =>
    scenario !== "long-loop" &&
    [1, 2].every(
      (session) => cell("vector", scenario, session).requests === cell("claude-code", scenario, session).requests,
    ),
)
const gap = (session: number) =>
  matched.map(
    (scenario) =>
      100 * (1 - cell("vector", scenario, session).costUsd / cell("claude-code", scenario, session).costUsd),
  )
const range = (values: number[]) => {
  const [low, high] = [Math.round(Math.min(...values)), Math.round(Math.max(...values))]
  return low === high ? `${low}%` : `${low}–${high}%`
}

test("the cost figures come from the archived efficiency benchmark, against Claude Code only", () => {
  expect(matched).toEqual(["solo-fix", "delegate-explore", "delegate-general"])
  expect(story).toContain(
    `Vector's modelled cost was ${range(gap(1))} lower in the first session and ${range(gap(2))} lower in a second`,
  )
  expect(story).toContain(`value: "${range(gap(1))}"`)
  expect(story).toContain(`value: "${range(gap(2))}"`)
  // The hero's figure spans both sessions. Its heading names whose agent did the work and its qualifier says both were
  // priced alike, so the saving can't be read as Vector making Claude Code cheaper or as a cheaper model.
  const both = range([...gap(1), ...gap(2)])
  expect(lander).toContain(`const heroCost = "${both}"`)
  expect(lander).toContain(
    `<h1 class="headline" id="hero-title"> Vector's own agent did the same scripted work as Claude&nbsp;Code for <span class="headline-figure">{heroCost}&nbsp;less</span> modelled spend. </h1>`,
  )
  expect(lander).toContain(
    "Both were priced at the same list rates, so the difference is what each agent sends with every request.",
  )
  // The claim is made once, beside its qualifier: the redrawn home page in the app's browser doesn't repeat it.
  expect(page.match(/modelled spend/g)).toHaveLength(1)
  expect(shots.filter((shot) => shot.text.includes(both) || shot.text.includes("modelled spend"))).toEqual([])
})

test("no label calls a session cold or warm, because the simulated cache carries across tasks", () => {
  expect(story).toContain("The archive's fourth task, a 12-turn investigation, is left out because its script reads a file that does not exist.")
  // A first session can read what an earlier task cached, so no label calls it cold or the second one warm.
  expect(cell("claude-code", "delegate-explore", 1).firstPrimaryCacheRead).toBeGreaterThan(0)
  expect(story).toContain("so a first session can already read what an earlier task cached")
  expect(story).not.toMatch(/warmed simulated cache|cold cache|cold start/)
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

test("every benchmark figure keeps its date and its caveats", async () => {
  // The integrated HTTP runs all started on 11 October 2026 (UTC).
  const dates = manifest.reports
    .filter((report) => report.file.startsWith("raw/integrated-http-"))
    .map((report) => report.provenance.startedAt.slice(0, 10))
  expect(new Set(dates)).toEqual(new Set(["2026-10-11"]))
  expect(story).toContain("run 11 October 2026 against Claude Code 2.1.215")
  expect(lander).toContain(
    "From Vector's offline benchmark of three scripted coding tasks against a fake model server, run 11 October 2026; it doesn't measure answer quality.",
  )
  expect(story).toContain("so the figure is not your bill")
  // The caveat in full once, in note b, including the archive's own warning; the section head only points to it.
  expect(story).toContain(
    "The benchmark measures what each agent sends for identical scripted work, not a live bill or answer quality, and the archive itself says it is no proof that Vector costs less in general.",
  )
  expect(await Bun.file(path.join(archive, "README.md")).text()).toContain(
    "not a live model quality evaluation or proof that Vector is generally cheaper",
  )
  expect(page.match(/answer quality/g)).toHaveLength(2)
  expect(page.match(/fake model server/g)).toHaveLength(2)
  expect(story).toContain("The notes under the numbers say what it measures and what it doesn't.")
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
  // Search results cut a description at about 160 characters.
  expect(index.match(/description="([^"]+)"/)![1].length).toBeLessThanOrEqual(160)
  // The heading is the edge; the wordmark above it is decoration.
  expect(lander).toContain('<div class="wordmark" aria-hidden="true">')
  expect(lander.match(/<h1\b/g)).toHaveLength(1)
  // One plain sentence in the hero says what Vector is, and the story doesn't say it again.
  expect(lander).toContain(
    `<p class="hero-deck simple-deck">Vector is ${definition}, built around a lean agent of its own.</p>`,
  )
  expect([lander, story].join(" ").match(new RegExp(`Vector is ${definition}`, "g"))).toHaveLength(1)
  expect(story).toContain("Vector gives that work one place, on your desktop and in your terminal")
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
  expect(page.match(/batches of up to eight/g)).toHaveLength(2) // the ticker and its screen-reader sentence
  expect(page.match(/your branch before you push/g)).toHaveLength(2) // likewise
  // The product tour doesn't list again what its own paragraph and the cards below it say.
  expect(lander).not.toContain("workspaceFacts")
  // Plugins and MCP servers add tools, so the engine's own tools are lean, not a fixed set.
  expect(page).not.toContain("fixed set of tools")
})

test("the Run Guard, scheduled-agent and Vectorscope figures are the ones that ship", () => {
  expect(DEFAULT_SPEND_POLICY.interactive).toEqual({})
  const perRun = DEFAULT_SPEND_POLICY.unattended.perRun?.usd
  const perDay = DEFAULT_SPEND_POLICY.unattended.perDay?.usd
  expect(story).toContain("run without a cap until you set one in Settings, Spend limits")
  expect(story).toContain(`automations start with limits of $${perRun} a run and $${perDay} a day`)
  // The pillar keeps the qualifier beside the claim; note c gives the defaults once.
  expect(story).toContain("Desktop only, and not yet on Windows WSL servers. Chats and parallel agents have no cap until you set one.")
  expect(page.match(/\$5 a run and \$25 a day/g)).toHaveLength(1)
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
  expect(story).toContain("The terminal gets the Run Guard with the next CLI release")
  expect(story).toContain("Background subagents reach the terminal with the next CLI release")
  expect(story.match(/Windows WSL servers/g)?.length).toBe(4)
  expect(story.match(/once a later desktop release requires that CLI/g)).toHaveLength(1)
})

test("Vector Velocity is in development, sized by its active parameters only", () => {
  expect(story).toContain('label: "Vector Velocity", status: { kind: "dev", text: "In development" }')
  expect(story).toContain(
    "The harness cuts what each request carries; Velocity is designed to cut what each token costs, with under 20B parameters active per token.",
  )
  // No total size, no base model, no compute provider.
  expect(
    [page, ...shots.map((shot) => shot.text)].filter((text) =>
      /(?<![-\w.])\d+(?:B\+|B model| billion parameter)/.test(text),
    ),
  ).toEqual([])
  expect(page).not.toMatch(/\b\d{3,}B (?:total|parameters)\b|\bover \d{3}B?\b/i)
  expect(page).not.toMatch(/Velocity[^.]*\b(?:built on|based on|fine-tun\w*|base model)\b|compute credits/i)
  expect(page).not.toMatch(/plan to build|Velocity[^."]*\bplanned\b/i)
  expect(lander).toContain('"is building a coding model of its own."')
  // Why it matters: four large coding models with a public size or base, the same four the investor page compares,
  // each with its active size from its maker's own page (the open base for the two whose makers publish none), and
  // the saving stated as a design goal. Closed models without a public size are not compared.
  expect(story).toContain(
    "Four of the largest coding models with a public size or base use more per token: 35B for Qwen3-Coder-480B, 32B for Kimi K2.7 Code, and, going by the open models they are built on, 32B for Cursor's Composer 2.5 and 104B for Cognition's SWE-2.",
  )
  ;[
    "https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "https://huggingface.co/moonshotai/Kimi-K2.7-Code",
    "https://cursor.com/blog/composer-2-5",
    "https://huggingface.co/moonshotai/Kimi-K2.5",
    "https://cognition.com/blog/swe-2",
    "https://huggingface.co/moonshotai/Kimi-K3",
  ].forEach((source) => expect(story).toContain(`href: "${source}"`))
  expect(story).toContain(
    "designed to cost significantly less to run than all four. That is a design goal, not a measured result.",
  )
  expect(page).not.toMatch(/largest models coding agents run on|than all three/)
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

test("no picture of the session view shows a Publish button", () => {
  // From desktop 1.99.109, publishing lives in Vector Cloud, reached from Home; the session's browser has no
  // Publish button (session-side-panel.tsx), so the redrawn session and its browser don't either.
  expect(shots.filter((shot) => /data-browser-publish|\bPublish\b/.test(shot.text)).map((shot) => shot.file)).toEqual([])
})

// The page ships with desktop 1.99.109 and describes or draws two things due in that release: free models labelled
// "May train on your prompts" behind a one-time question, and the sidebar's "Repositories" and "Repository tools"
// labels. Once the published desktop version reaches 1.99.109, the app in the same tree must have both; if either
// slipped, put back the free models' status label or the old sidebar labels in the redraw.
test.skipIf(Bun.semver.order(publishedDesktopVersion, "1.99.109") < 0)(
  "once desktop 1.99.109 is published, the app has what the page says that release brings",
  async () => {
    const source = async (dir: string) =>
      Promise.all(
        (await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: path.join(repo, dir) }))).map((file) =>
          Bun.file(path.join(repo, dir, file)).text(),
        ),
      )
    const app = [...(await source("packages/app/src")), ...(await source("packages/core/src"))]
    expect(app.some((text) => text.includes("May train on your prompts"))).toBe(true)
    expect(app.some((text) => text.includes("Repository tools"))).toBe(true)
    const nav = await Bun.file(path.join(repo, "packages/app/src/components/workspace-navigation.tsx")).text()
    expect(nav).not.toMatch(/>\s*Projects\s*<|Project tools/)
  },
)

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
