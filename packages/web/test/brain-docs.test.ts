import { expect, test } from "bun:test"
import path from "node:path"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { TaskSize } from "@vectordevai/core/task-size"
import { BrainEmbedManifest } from "@vectordevai/core/brain/embed-manifest"
import { brainBudgetRows, brainCommandRows, documentCommandRows, knowledgeEval, modelCommandRows } from "../src/data/docs-content"
import { brainCopy, brainRelease, publishedDesktopVersion } from "../src/data/vector-releases"
import { docsMoved, docsNav } from "../src/data/docs-nav"

// The brain's docs pages (desktop 1.99.110) and the README's section on it describe what this tree does: the budgets
// are the engine's, the commands are the CLI's, and every number comes from the dated knowledge eval.
const web = path.join(import.meta.dir, "..")
const repo = path.join(web, "../..")
const read = async (file: string) => (await Bun.file(path.join(repo, file)).text()).replace(/\s+/g, " ")
const brain = await read("packages/web/src/pages/docs/brain.astro")
const documents = await read("packages/web/src/pages/docs/documents.astro")
const meaning = await read("packages/web/src/pages/docs/search-by-meaning.astro")
const readme = await read("README.md")
const section = readme.slice(readme.indexOf("### Vector Brain"), readme.indexOf("### Agents"))
const report = await Bun.file(path.join(repo, `${knowledgeEval.report}/report.json`)).json()
const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]

test("Vector Brain and Documents and code links are pages of their own, and old local-memory links land on the brain", async () => {
  const features = docsNav.find((group) => group.label === "Features")?.links.map((link) => link.id) ?? []
  expect(features).toContain("brain")
  expect(features).toContain("documents")
  expect(features).not.toContain("local-memory")
  expect(brain).toContain('<DocsPage id="brain">')
  expect(documents).toContain('<DocsPage id="documents">')
  expect(await Bun.file(path.join(web, "src/pages/docs/local-memory.astro")).exists()).toBe(false)
  // The /docs#local-memory shim and the /docs/local-memory redirect both reach the brain page.
  expect(docsMoved["local-memory"]).toBe("brain")
  const vercel = (await Bun.file(path.join(repo, "vercel.json")).json()) as {
    redirects: { source: string; destination: string }[]
  }
  expect(vercel.redirects.find((redirect) => redirect.source === "/docs/local-memory")?.destination).toBe("/docs/brain")
  // Every link between the two pages lands on a heading that exists.
  const links = Array.from(`${brain} ${documents}`.matchAll(/href="\/docs\/(brain|documents)#([\w-]+)"/g), (match) => ({
    page: match[1] === "brain" ? brain : documents,
    anchor: match[2]!,
  }))
  expect(links.length).toBeGreaterThan(0)
  for (const link of links) expect(link.page).toContain(`<h2 id="${link.anchor}">`)
})

test("both pages and their sidebar entries name desktop 1.99.110, and the brain page says what leaves the computer", () => {
  for (const id of ["brain", "documents"])
    expect(docsNav.flatMap((group) => group.links).find((link) => link.id === id)?.blurb).toStartWith(
      "From desktop 1.99.110:",
    )
  expect(brain).toContain("From desktop 1.99.110, Vector keeps a brain for each repository")
  expect(documents).toContain("From desktop 1.99.110, you can give Vector a repository's specs")
  expect(brain).toContain(
    "All of it is stored and searched on this computer. For each request Vector sends your model only the few lines that bear on it. Private documents never go to a model that may train on prompts, or to a session a guest is in.",
  )
  // Readers still on 1.99.109 are told what they have.
  expect(brain).toContain("Desktop 1.99.109 and earlier keep one <code>MEMORY.md</code> file")
})

test("the budgets the brain page gives are the ones recall uses", () => {
  const rows = Object.fromEntries(brainBudgetRows)
  expect(Object.keys(rows)).toEqual(["Chat", "Light", "Standard", "Thorough"])
  expect(Brain.recallBudget("chat")).toBe(0)
  expect(BrainKnowledge.budget("chat", { documents: true, tight: false })).toBe(0)
  expect(rows.Chat).toContain("Nothing")
  for (const tier of ["light", "standard", "thorough"] as const) {
    const row = rows[`${tier[0]!.toUpperCase()}${tier.slice(1)}`]
    expect(row).toContain(
      `Up to ${Brain.recallBudget(tier)} tokens, or ${BrainKnowledge.budget(tier, { documents: true, tight: false })} in a repository with documents.`,
    )
  }
  // The README's ceiling is the Thorough budget with documents, and it bounds recall only: like the brain page, the
  // README says every request but a greeting also carries the fixed part.
  expect(section).toContain(
    `On top of that, Vector recalls only the few lines that bear on the request, within a budget set by its size, at most ${BrainKnowledge.budget("thorough", { documents: true, tight: false })} tokens for a Thorough request in a repository with documents.`,
  )
  expect(section).toContain(
    `Every request but a greeting carries a fixed part: your rules, about ${Brain.BUDGET.memory} tokens of \`MEMORY.md\`, the entries you pinned (about ${Brain.BUDGET.pinned} tokens) and one line saying what else the brain holds`,
  )
  expect(section).toContain('A greeting such as "hi" carries none of it.')
  expect(brain).toContain(
    `Every request but a greeting carries your rules, the start of <code>MEMORY.md</code> (about ${Brain.BUDGET.memory} tokens of it), the entries you pinned (about ${Brain.BUDGET.pinned} tokens) and one line saying what else the brain holds.`,
  )
  expect(section).not.toMatch(/sends your model only the few lines/)
  // What the page says about the cached part, a file read and a subagent's brief.
  expect(brain).toContain(`about ${Brain.BUDGET.memory} tokens of it`)
  expect(brain).toContain(`(about ${Brain.BUDGET.pinned} tokens)`)
  expect(brain).toContain(`up to about ${Brain.BUDGET.attach} tokens of memory about that file`)
  expect(brain).toContain(`up to ${BrainKnowledge.BRIEF.tokens} tokens of the cards and memory`)
  expect(brain).toContain(`for up to ${words[BrainKnowledge.BRIEF.subagents]} subagents a request`)
})

// "hi" and "ok" cost nothing only when nothing waits on them; the page says when they are sized as work instead.
test("the page sizes a greeting or a bare acknowledgement as TaskSize does", () => {
  expect(brain).toContain(
    'A greeting or a bare acknowledgement, such as "hi" or "ok", is sized Chat unless work is waiting on you: one that answers a question the agent asked, follows a run that did not finish, or approves a plan from Plan mode is sized as the work it carries on.',
  )
  for (const text of ["hi", "ok"]) expect(TaskSize.classify({ text }).tier).toBe("chat")
  for (const text of ["hi", "ok"]) expect(TaskSize.classify({ text, open: true, previous: "standard" }).tier).not.toBe("chat")
  expect(TaskSize.classify({ text: "ok", plan: true, previous: "standard" }).tier).not.toBe("chat")
  expect(TaskSize.classify({ text: "hi", plan: true, previous: "standard" }).tier).toBe("chat")
})

// Only `vector review` reads the brain's requirements; the desktop's Vectorscope does not yet, and the page says so.
test("the page gives linked requirements to the terminal's Vectorscope review only, with the next CLI release", async () => {
  const review = await Bun.file(path.join(repo, "packages/engine/src/cli/cmd/review.ts")).text()
  const desktop = await Bun.file(path.join(repo, "packages/app/src/features/pull-requests/ai-review.ts")).text()
  expect(review).toContain("ReviewContext.requirements(")
  expect(desktop).not.toMatch(/ReviewContext|requirements/)
  expect(brain).toContain(
    'With the next CLI release, a <a href="/docs/vectorscope">Vectorscope</a> review you run in the terminal with <code>vector review</code> gets the requirements',
  )
  expect(brain).toContain("Vectorscope reviews in the desktop app do not get them yet.")
  expect(brain).not.toMatch(/(?<!run in the terminal with <code>vector review<\/code> )gets the requirements/)
})

test("every terminal command the pages list is one the CLI has", async () => {
  const cli = [
    await Bun.file(path.join(repo, "packages/engine/src/cli/cmd/memory.ts")).text(),
    await Bun.file(path.join(repo, "packages/engine/src/cli/cmd/memory-doc.ts")).text(),
  ].join("\n")
  const commands = [...brainCommandRows, ...documentCommandRows, ...modelCommandRows].map(([command]) => command!)
  expect(commands.every((command) => command.startsWith("vector memory "))).toBe(true)
  const missing = commands
    .map((command) => command.replace(/^vector memory (doc )?/, "").split(" ")[0]!)
    .filter((name) => !new RegExp(`command: (?:\\[\\s*)?"${name}[ "]|simple\\(\\s*"${name}"`).test(cli))
  expect(missing).toEqual([])
})

test("the eval figures in the docs and the README are the dated report's", () => {
  const working = report.found.working
  const hops = report.found.hops
  const requests = report.fixture.working + report.fixture.hops + report.fixture.irrelevant
  expect(report.date).toBe("2026-10-19")
  expect(report.dirty).toBe(false)
  expect(knowledgeEval.date).toBe("19 October 2026")
  expect(knowledgeEval.summary).toContain(
    `On the knowledge eval of 19 October 2026, recall through code links brought in the governing requirement for ${working.pagerank} of ${working.tasks} tasks that named the files they touch, against ${working.keywords} of ${working.tasks} by keywords alone, and for ${hops.pagerank} of ${hops.tasks} tasks that edited a file which only imports the governed one, where spreading activation over code links found ${hops.activation} of ${hops.tasks}.`,
  )
  expect(knowledgeEval.summary).toContain(
    `A Light request carried ${Math.round(report.tokens.light.mean)} tokens on average, and ${report.fixture.irrelevant} unrelated requests, "hi" among them, carried none at any size.`,
  )
  expect([...report.irrelevant.pagerank, report.tokens.chat.max]).toEqual(Array.from({ length: 11 }, () => 0))
  expect(knowledgeEval.caveat).toContain(
    `The eval is ${words[report.fixture.documents]} short specs for a small invented repository and ${requests} requests, written alongside the feature, with no language model call. It is not an independent benchmark.`,
  )
  expect(documents).toContain("{knowledgeEval.summary}")
  expect(documents).toContain("{knowledgeEval.caveat}")
  expect(section).toContain(
    `On the [knowledge eval of 19 October 2026](${knowledgeEval.report}/README.md), recall through code links brought in the governing requirement for ${working.pagerank} of ${working.tasks} tasks that named the files they touch, against ${working.keywords} of ${working.tasks} by keywords alone, at ${Math.round(report.tokens.light.mean)} tokens a Light request on average, and ${report.fixture.irrelevant} unrelated requests carried none.`,
  )
  expect(section).toContain(
    `Keywords and meaning, with no code links, found ${working.meaning} of ${working.tasks}. The eval is ${words[report.fixture.documents]} short specs and ${requests} requests written alongside the feature, with no language model call; it is not an independent benchmark.`,
  )
})

// README.md cannot read the published version, so it is held to it here: coming in 1.99.110 until the download page
// offers that release, then from it. Publishing 1.99.110 fails this test until the README says so.
test("the README names the release the brain ships in, as coming until it is published", () => {
  expect(readme).toContain(brainRelease.readme)
  expect(section).toStartWith(brainRelease.heading)
  const other = brainCopy(Bun.semver.order(publishedDesktopVersion, "1.99.110") < 0 ? "1.99.110" : "1.99.109")
  expect(readme).not.toContain(other.readme)
  expect(readme).not.toContain(other.heading)
  expect(section).toContain("with the next CLI release")
})

test("the brain's copy keeps to the owner's wording rules", () => {
  for (const text of [brain, documents, meaning, section, knowledgeEval.summary, knowledgeEval.caveat, knowledgeEval.meaning, knowledgeEval.floor]) {
    expect(text).not.toMatch(/\bexactly\b|never exceeds|absolute privacy|guaranteed/i)
    expect(text).not.toMatch(/\bprojects?\b/i)
    expect(text).not.toMatch(/(cheaper|faster) than Codex|Codex[^.]*(cheaper|faster)/i)
    // Only the eval's figures: no timings, which change with the machine.
    expect(text).not.toMatch(/\d\s?ms\b|\d+(\.\d+)? s\b/)
  }
  // Every PDF and doc claim stays inside what the readers do: no text read from images until a later release.
  expect(documents).toContain("Pictures of text, such as scanned pages, are named but not read")
  expect(`${brain} ${documents} ${section}`).not.toMatch(/\bOCR\b/)
})

test("Search by meaning has its own page, from desktop 1.99.110, with the manifest's model, size, license and revision", () => {
  const features = docsNav.find((group) => group.label === "Features")?.links ?? []
  const page = features.find((link) => link.id === "search-by-meaning")
  expect(page?.title).toBe("Search by meaning")
  expect(page?.blurb).toStartWith("From desktop 1.99.110:")
  expect(meaning).toContain('<DocsPage id="search-by-meaning">')
  expect(meaning).toContain("From desktop 1.99.110, Vector can also search your")
  // Sizes and pins come from the manifest itself, so the page cannot drift from what Vector downloads.
  expect(meaning).toContain("BrainEmbedManifest.size(arctic)")
  expect(meaning).toContain("arctic.revision.slice(0, 12)")
  expect(meaning).toContain("const graph = arctic.files.model.sha256")
  expect(meaning).toContain("{graph.slice(0, 16)}")
  expect(BrainEmbedManifest.megabytes(BrainEmbedManifest.size(BrainEmbedManifest.MODELS["arctic-embed-xs-q8"]))).toBe("24 MB")
  expect(meaning).toContain("Nothing is downloaded until you ask")
  expect(meaning).toContain("Until you do, Vector searches documents by keywords and code links")
  expect(meaning).toContain("never for a model that may train on prompts, or in a session a guest is in")
  expect(documents).toContain('<a href="/docs/search-by-meaning">Search by meaning</a>')
  expect(section).toContain("With the optional local search model, a one-time 24 MB download you ask for")
})

test("the meaning figures are the dated report's, run with the pinned model", () => {
  const working = report.found.working
  const hops = report.found.hops
  expect(report.dense.model).toBe(`${BrainEmbedManifest.MODELS["arctic-embed-xs-q8"].repo}@${BrainEmbedManifest.MODELS["arctic-embed-xs-q8"].revision.slice(0, 12)} int8`)
  expect(knowledgeEval.meaning).toBe(
    `With the search model, the same requests found the governing requirement for ${working.meaning} of ${working.tasks} tasks by keywords and meaning alone, with no code links, against ${working.keywords} of ${working.tasks} by keywords alone; with every channel at once, for ${working.all} of ${working.tasks}, and ${hops.all} of ${hops.tasks} through an import. The ${report.fixture.irrelevant} unrelated requests carried no tokens with it either.`,
  )
  expect(report.dense.irrelevant).toEqual(Array.from({ length: report.fixture.irrelevant }, () => 0))
  expect(meaning).toContain("{knowledgeEval.meaning}")
  expect(meaning).toContain("{knowledgeEval.floor} {knowledgeEval.caveat}")
})

// The floor was tuned on the eval it is quoted from, so the page gives the margin the report's sweep measured, not a
// claim of room to spare.
test("the meaning floor's margin is the one the dated report's sweep measured", async () => {
  const dense = report.dense
  expect(dense.floor).toBe(BrainEmbedManifest.MODELS["arctic-embed-xs-q8"].floor)
  expect(dense.sweep.map((row: { floor: number }) => row.floor)).toContain(dense.floor)
  expect(knowledgeEval.floor).toBe(
    `The least score a match by meaning needs, ${dense.floor}, was set on this same eval. There the unrelated requests carried no cards from ${dense.clear.toFixed(2)} up, and at ${dense.leak.floor.toFixed(2)} ${words[dense.leak.requests]} of them carried ${dense.leak.tokens} tokens, so the floor sits ${(dense.floor - dense.clear).toFixed(2)} above the least that kept them out, and these figures are not an out-of-sample result.`,
  )
  const manifest = await Bun.file(path.join(repo, "packages/core/src/brain/embed-manifest.ts")).text()
  const archive = await Bun.file(path.join(repo, `${knowledgeEval.report}/README.md`)).text()
  for (const text of [knowledgeEval.floor, manifest, archive]) expect(text).not.toContain("room to spare")
  expect(archive).toContain("## The meaning floor")
})
