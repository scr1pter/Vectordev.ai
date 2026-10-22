import { expect, test } from "bun:test"
import path from "node:path"
import { legacyName } from "@vectordevai/core/flag/legacy"
import { brainCopy, brainRelease, publishedDesktopVersion } from "../src/data/vector-releases"

// The landing page is the product tour. Every claim on it has to hold for the desktop release it ships with, and
// everything that is not live yet has to say so.
const web = path.join(import.meta.dir, "..")
const repo = path.join(web, "../..")
// Template text wraps across lines, so the copy is compared with its whitespace folded.
const read = async (file: string) => (await Bun.file(path.join(web, file)).text()).replace(/\s+/g, " ")
const lander = await read("src/components/Lander.astro")
const index = await read("src/pages/index.astro")
const footer = await read("src/components/marketing/SiteFooter.astro")
const shots = await Promise.all(
  (await Array.fromAsync(new Bun.Glob("src/components/marketing/shots/*.astro").scan({ cwd: web }))).map(
    async (file) => ({ file, text: await read(file) }),
  ),
)
const page = [lander, index, footer].join("\n")
// Link targets are left out: a model card's address can name an active size, though no page text does.
const visible = [page, ...shots.map((shot) => shot.text)].map((text) => text.replace(/href(?:: |=)"[^"]*"/g, ""))

// The brain ships in desktop 1.99.110, built in this tree, and the site deploys from main. Its section and the memory
// card name that release, and say it is coming until the download page offers it, then that it is new in it.
test("the brain's release labels say coming in desktop 1.99.110 until that release is published, then new in it", () => {
  for (const version of ["1.99.108", "1.99.109"])
    expect(brainCopy(version)).toMatchObject({ kicker: "coming in desktop 1.99.110", since: "Coming in desktop 1.99.110:" })
  for (const version of ["1.99.110", "1.99.111", "1.100.0", "2.0.0"])
    expect(brainCopy(version)).toMatchObject({ kicker: "new in desktop 1.99.110", since: "From desktop 1.99.110," })
  expect(brainRelease).toEqual(brainCopy(publishedDesktopVersion))
  for (const version of ["1.99.109", "1.99.110"])
    for (const label of Object.values(brainCopy(version))) expect(label).not.toMatch(/\bexactly\b|\bprojects?\b/i)
})

test("the self-evolving agent and the memory card name desktop 1.99.110, the release the brain ships in", async () => {
  expect(await Bun.file(path.join(repo, "packages/core/src/brain/brain.ts")).exists()).toBe(true)
  expect(await Bun.file(path.join(repo, "packages/core/src/brain/knowledge.ts")).exists()).toBe(true)
  expect(lander).toContain('<p class="story-kicker" data-reveal>Self-evolving · {brainRelease.kicker}</p>')
  expect(lander).toContain('data-chapter="Self-evolving"')
  // The owner's title for the section (19 October 2026): the brain learns the people and the company, not only the code.
  expect(lander).toContain(
    '<h2 id="evolving-title" class="story-title" data-reveal>An agent that learns you and your&nbsp;company.</h2>',
  )
  expect(lander).not.toContain("An agent that learns your&nbsp;repository.")
  expect(lander).toContain(
    "`${brainRelease.since} rules, memory and the documents you add are stored and searched on your computer",
  )
  // Nothing else on the page calls the release out, shipped or coming, on its own.
  const labels = lander.replace(/\$?\{brainRelease\.\w+\}/g, "")
  expect(labels).not.toMatch(/(new|coming) in (desktop )?1\.99\.110|From desktop 1\.99\.110/)
  expect(lander).toContain('href: "/docs/brain"')
  expect(lander).not.toContain("/docs/local-memory")
  expect(lander).not.toMatch(/Vector (now )?(learns|remembers)[^.]*today/i)
})

// Every number the section gives comes from the dated knowledge eval, with its date and what it is not.
test("the self-evolving section quotes the dated knowledge eval and keeps its caveat", async () => {
  const report = await Bun.file(path.join(repo, "docs/benchmarks/vector-knowledge-2026-10-19/report.json")).json()
  const working = report.found.working
  const section = lander.slice(
    lander.indexOf('<section id="evolving"'),
    lander.indexOf("</section>", lander.indexOf('<section id="evolving"')),
  )
  expect(report.date).toBe("2026-10-19")
  expect(report.dirty).toBe(false)
  expect(section).toContain(
    `On Vector's knowledge eval of 19 October 2026, recall through code links brought in the governing requirement for ${working.pagerank} of ${working.tasks} tasks, against ${working.keywords} of ${working.tasks} by keywords alone, at ${Math.round(report.tokens.light.mean)} tokens a request on average.`,
  )
  expect(section).toContain(
    `The eval is ${["zero", "one", "two", "three", "four", "five", "six"][report.fixture.documents]} short specs and ${report.fixture.working + report.fixture.hops + report.fixture.irrelevant} requests written alongside the feature, not an independent benchmark.`,
  )
  // The only figures in the section are the eval's, and none of them is a time.
  const words = section.replace(/<[^>]+>/g, " ").replace(/1\.99\.110|19 October 2026/g, "")
  const figures = Array.from(words.matchAll(/\d[\d,.]*/g), (match) => match[0])
  expect(figures.toSorted()).toEqual(
    [
      working.pagerank,
      working.tasks,
      working.keywords,
      working.tasks,
      Math.round(report.tokens.light.mean),
      report.fixture.working + report.fixture.hops + report.fixture.irrelevant,
    ]
      .map(String)
      .toSorted(),
  )
  expect(section).not.toMatch(/\bms\b|seconds|faster|cheaper|Codex/i)
})

// The owner's control line (20 October 2026), said only as far as the code backs it: brain.db sits in Vector's data
// folder on this computer, the user picks the model, Settings → Memory lists what was learned with Undo and Tidy and
// erase, and free models that may train carry their label. Memory in every agent is not built yet, so it stays off.
test("the self-evolving section says whose prompts and data they are, and no more", async () => {
  const section = lander.slice(
    lander.indexOf('<section id="evolving"'),
    lander.indexOf("</section>", lander.indexOf('<section id="evolving"')),
  )
  expect(await Bun.file(path.join(repo, "packages/core/src/brain/database.ts")).text()).toContain(
    "BrainPaths.directory(Global.Path.data)",
  )
  const memory = await Bun.file(path.join(repo, "packages/app/src/components/settings-v2/memory.tsx")).text()
  expect(memory).toContain('action: "undo"')
  expect(memory).toContain("current.memory.erase(")
  expect(section).toContain(
    "Your prompts, your data, your Vector: the brain lives on your computer, you choose who runs the model for each request, and you can see, undo or erase what it learned. Free models labelled May train on your prompts are the exception.",
  )
  expect(page).not.toMatch(/\bfully\b|controlled only by you|only you control|your prompts never/i)
  expect(section).not.toMatch(/every agent|Deep research|Vectorscope/i)
})

// The owner's emphasis (22 October 2026): Vector is the self-evolving, low-cost AI agentic harness, built on technology
// of its own. The hero, the page's title and description and the README's opening say so, with the brain's release
// from brainRelease, since the brain is what makes it self-evolving.
test("the hero, the title and the README call Vector the self-evolving, low-cost AI agentic harness", async () => {
  const source = await Bun.file(path.join(web, "src/pages/index.astro")).text()
  const readme = (await Bun.file(path.join(repo, "README.md")).text()).replace(/\s+/g, " ")
  expect(lander).toContain('<span class="headline-lead">The self-evolving AI agentic harness&nbsp;that</span>')
  expect(lander).toContain('<span class="sr-only">The self-evolving AI agentic harness that has an agent of its own,')
  expect(lander).toContain(
    "Low-cost by design and built on proprietary technology. Vector Brain, {brainRelease.lede}, links your specs, PDFs and docs to the code and recalls only what a request needs, offline.",
  )
  expect(lander).toContain(
    "In the desktop app, the tokenomics engine sizes each request and stops a run within a step of your cap",
  )
  expect(source).toContain('title="Vector — the self-evolving, low-cost AI agentic harness"')
  expect(source).toContain(
    "description={`The self-evolving, low-cost AI agentic harness. Vector Brain, ${brainRelease.lede},",
  )
  expect(readme).toContain(
    "**The self-evolving, low-cost AI agentic harness for planning, building, reviewing and shipping software.**",
  )
  expect(readme).toContain("It is built on proprietary technology: the **tokenomics engine**")
  // The brain's own name, everywhere.
  expect([page, readme].filter((text) => /gbrain/i.test(text))).toEqual([])
})

// "Low-cost" rests on one published benchmark, quoted with its caveats: the integrated HTTP cells of the efficiency
// archive, Vector on the Messages API against Claude Code at the same rates, as the investor page quotes it.
test("the cost claim quotes the efficiency archive's first-session range against Claude Code, with its caveats", async () => {
  const summary = await Bun.file(path.join(repo, "docs/benchmarks/vector-efficiency-2026-10/summary.json")).json()
  const readme = (await Bun.file(path.join(repo, "README.md")).text()).replace(/\s+/g, " ")
  const cell = (
    runtime: string,
    scenario: string,
    session: number,
  ): { costUsd: number; requests: number } | undefined =>
    summary.cells.find(
      (item: { state: string; transport: string; runtime: string; scenario: string; session: number }) =>
        item.state === "integrated" &&
        item.transport === "http" &&
        item.runtime === runtime &&
        item.scenario === scenario &&
        item.session === session,
    )
  // long-loop is left out for the reason test/investor-page.test.ts gives: its fixture lacks a file the script reads.
  const scenarios = ["solo-fix", "delegate-explore", "delegate-general"]
  const range = (session: number) => {
    const savings = scenarios.map((scenario) => {
      const vector = cell("vector", scenario, session)
      const claude = cell("claude-code", scenario, session)
      expect(vector?.requests).toBe(claude?.requests)
      return Math.round((1 - (vector?.costUsd ?? 0) / (claude?.costUsd ?? 1)) * 100)
    })
    if (Math.min(...savings) === Math.max(...savings)) return `${savings[0]}%`
    return `${Math.min(...savings)}–${Math.max(...savings)}%`
  }
  expect(lander).toContain(
    `Low cost, measured: in Vector's offline efficiency benchmark of October 2026, its modelled spend on three scripted fix tasks in a first session was ${range(1)} below Claude Code 2.1.215's, at the same list rates. It measures what each agent sends, not the quality of answers or your provider's bill, and does not show that Vector is cheaper than other agents in general.`,
  )
  expect(readme).toContain(
    `Vector's modelled spend was ${range(1)} lower in a first session and ${range(2)} lower in a second, run as a new process`,
  )
  ;[
    "docs/benchmarks/vector-efficiency-2026-10/README.md",
    "(commit 6f7f3c2ea) and Claude Code 2.1.215",
    "identical scripted tool steps against a local fake model server",
    "the same number of model requests",
    "medians of three repetitions",
    "characters ÷ 4",
    "not the quality of answers",
    "does not show that Vector is cheaper than other agents in general",
  ].forEach((caveat) => expect(readme).toContain(caveat))
  // Never a bare superlative, and nothing from the archive where Claude Code or Codex comes out ahead.
  expect(
    [page, readme].filter((text) => /\bcheapest\b|\blowest[- ]cost\b|MiB|wall[- ]time|Codex [^,.]*cheaper/i.test(text)),
  ).toEqual([])
})

test("Vector Velocity is in development and branded by one size, 550B parameters", () => {
  expect(lander).toContain('"is building a 550B model of its own."')
  expect(lander).toContain("and is building a 550B-parameter model of its own.")
  expect(lander).toContain("Velocity, the 550B-parameter model we're building")
  // One size, and nothing about how many of its parameters run per token.
  expect(new Set(visible.flatMap((text) => Array.from(text.matchAll(/(\d+)B(?:-parameter| model)/g), (match) => match[1])))).toEqual(
    new Set(["550"]),
  )
  expect(
    visible.filter((text) =>
      /\bactive (?:per token|param\w*)|parameters active|\bactivated\b|\bA\d+B\b|\bunder \d+B\b|\d+B (?:active|per token|for every token)|parameters (?:per|for every) token|300B|300 billion/i.test(
        text,
      ),
    ),
  ).toEqual([])
  // No base model and no compute provider.
  expect(page).not.toMatch(/Velocity[^.]*\b(?:built on|based on|fine-tun\w*|base model)\b|compute credits|Nebius/i)
})

test("what is not live when the page ships is labelled, and what ships with it is not", () => {
  // Free models provided by Vector, with may-train models labelled and a one-time question, ship in desktop 1.99.109
  // with this page. The owner's wording (19 October 2026) says Vector provides them, never a shared allowance.
  expect(lander).toContain("Sign in to Vector and its free models are provided by Vector at no cost to you")
  expect(lander).toContain("every free OpenRouter model that can use tools and whose terms allow Vector to provide it")
  expect(page).not.toMatch(/shared allowance|allow shared use/i)
  expect(lander).not.toMatch(/connect a free OpenRouter account|your own OpenRouter account/i)
  expect(lander).toContain("sent only after you accept that once")
  expect(page).toContain("May train on your prompts")
  expect(page).not.toContain("Models included with Vector")
  expect(page).not.toMatch(/no matter which model|whichever model/i)
  // Codium sales are closed.
  expect(lander).toContain("Codium, coming soon")
  // Eight is the batch size, not a limit on subagents running together, and nothing says subagents have no cap.
  expect(lander).toContain('"runs subagents in batches of up to eight."')
  expect(page).not.toMatch(/eight subagents at once|subagents[^."]*no cap|no cap[^."]*subagents/i)
  // Only Vector's own agent's runs are priced, and a spend cap is never a promise to the cent.
  expect(page).not.toMatch(/\bexactly\b|never exceeds|guaranteed|holds a run to|every chat priced|prices every chat/i)
  expect(page).not.toMatch(/cost of every run|economics of every run|absolute privacy|really cost|all of it stays/i)
  // The judge is off by default and checks only large tasks; there is no hosted agent; inviting is a terminal command.
  expect(page).not.toMatch(/verifies (?:its work )?before|from the cloud|invites your team/i)
  // No redrawn session shows a dollar figure of zero for tokens it spent; a plan session reads as the app shows it.
  expect(shots.filter((shot) => shot.text.includes("$0.00")).map((shot) => shot.file)).toEqual([])
  expect(shots.some((shot) => shot.text.includes("<b>ChatGPT plan</b>"))).toBe(true)
})

test("no picture of the session view shows a Publish button", () => {
  // From desktop 1.99.109, publishing lives in Vector Cloud, reached from Home; the session's browser has no
  // Publish button (session-side-panel.tsx), so the redrawn session and its browser don't either.
  expect(shots.filter((shot) => /data-browser-publish|\bPublish\b/.test(shot.text)).map((shot) => shot.file)).toEqual([])
})

// The page ships with desktop 1.99.109 and describes or draws two things due in that release: free models labelled
// "May train on your prompts" behind a one-time question, and the sidebar's "Repository tools" label (its group
// header became "Agents" on 20 Oct). Once the published desktop version reaches 1.99.109, the app in the same tree must have both; if either
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
  expect([lander, index, footer].filter((text) => /\bprojects?\b/i.test(text))).toEqual([])
  // The redrawn sidebar, dashboard and terminal name things the way the copy does.
  const named = shots.flatMap((shot) =>
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
  expect(named).toEqual([])
})

test("the landing page names neither the upstream project nor Cloud Services", () => {
  // The upstream name is derived from its MIT notice, so it is never written here either.
  expect(legacyName).toBeTruthy()
  expect([page, ...shots.map((shot) => shot.text)].filter((text) => text.toLowerCase().includes(legacyName!))).toEqual(
    [],
  )
  expect(page).not.toMatch(/Cloud [Ss]ervices/)
})
