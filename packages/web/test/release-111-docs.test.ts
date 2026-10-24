import { expect, test } from "bun:test"
import path from "node:path"
import { Brain } from "@vectordevai/core/brain/brain"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { ResearchConfidence } from "@vectordevai/core/research/confidence"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { ResearchPaywall } from "@vectordevai/core/research/paywall"
import { ResearchPlan } from "@vectordevai/core/research/plan"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchQuote } from "@vectordevai/core/research/quote"
import { ResearchRate } from "@vectordevai/core/research/rate"
import { ResearchStore } from "@vectordevai/core/research/store"
import { ConfigResearchV1 } from "@vectordevai/core/v1/config/research"
import { memoryRoleRows, researchCapRows } from "../src/data/docs-content"
import { docsNav } from "../src/data/docs-nav"
import { publishedDesktopVersion, release111, release111Copy, release111Version } from "../src/data/vector-releases"

// The docs for what desktop 1.99.111 brings (Deep research, its research browsers, Vector Local in the app, memory of
// you in every agent and learning about you) say what this tree does: every number is the code's, the copy is the
// app's own words, and each page says the release is coming until the download page offers it.
const repo = path.join(import.meta.dir, "../../..")
const read = async (file: string) => (await Bun.file(path.join(repo, file)).text()).replace(/\s+/g, " ")
const text = (page: string) => page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
const research = await read("packages/web/src/pages/docs/research.astro")
const local = await read("packages/web/src/pages/docs/local.astro")
const brain = await read("packages/web/src/pages/docs/brain.astro")
const browser = await read("packages/web/src/pages/docs/browser-agent.astro")
const models = await read("packages/web/src/pages/docs/models.astro")
const notes = await read("docs/vector/owner-actions/release-199111.md")
const features = docsNav.find((group) => group.label === "Features")?.links ?? []
const appResearch = await read("packages/app/src/features/research/research-model.ts")

// A string constant's value as its source file writes it, whitespace folded as the pages are read.
const constant = (source: string, name: string) => {
  const found = source.match(new RegExp(`\\b${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`))
  if (!found) throw new Error(`${name} is not a string constant in its file`)
  return String(JSON.parse(`"${found[1]}"`)).replace(/\s+/g, " ")
}

test("the release label follows the version the download page offers", () => {
  expect(release111Version).toBe("1.99.111")
  expect(release111Copy("1.99.110")).toMatchObject({ since: "Coming in desktop 1.99.111:", shipped: false })
  expect(release111Copy("1.99.111")).toMatchObject({ since: "From desktop 1.99.111:", shipped: true })
  expect(release111Copy("1.100.0").shipped).toBe(true)
  expect(release111.shipped).toBe(Bun.semver.order(publishedDesktopVersion, release111Version) >= 0)
})

test("Deep research has a page of its own, labelled as a preview and with the release that brings it", () => {
  const leaf = features.find((link) => link.id === "research")
  expect(leaf).toMatchObject({ title: "Deep research" })
  expect(leaf?.blurb).toStartWith(`${release111.since} a preview`)
  // It sits beside the browser agent, whose browsers it builds on.
  expect(features.findIndex((link) => link.id === "research")).toBe(
    features.findIndex((link) => link.id === "browser-agent") + 1,
  )
  expect(research).toContain('<DocsPage id="research">')
  expect(research).toContain("{release111.since} Deep research is a preview.")
  expect(research).toContain(`labelled <strong>${constant(appResearch, "PREVIEW")}</strong>`)
})

test("the research page's caps, limits and refusals are the engine's", () => {
  expect(Object.fromEntries(researchCapRows)).toEqual({
    Focused: `$${ResearchPlan.LIMITS.focused.usd}, ${ResearchPlan.LIMITS.focused.steps} steps, ${ResearchPlan.LIMITS.focused.pages} pages, ${ResearchPlan.LIMITS.focused.searches} searches and up to ${ResearchPlan.LIMITS.focused.researchers} researchers.`,
    Deep: `$${ResearchPlan.LIMITS.deep.usd}, ${ResearchPlan.LIMITS.deep.steps} steps, ${ResearchPlan.LIMITS.deep.pages} pages, ${ResearchPlan.LIMITS.deep.searches} searches and up to ${ResearchPlan.LIMITS.deep.researchers} researchers.`,
  })
  const page = text(research)
  expect(page).toContain(`plus up to ${ResearchPlan.LIMITS.focused.researchers} researchers`)
  expect(page).toContain(`Deep adds up to ${ResearchPlan.LIMITS.deep.researchers} researchers`)
  expect(page).toContain(`Runs you do not keep are deleted after ${ResearchStore.LIMIT.retain} days.`)
  expect(page).toContain(
    `at most ${ResearchStore.LIMIT.sources} sources and ${ResearchStore.LIMIT.bytes / 1024 / 1024} MB of page text`,
  )
  expect(page).toContain(`at most ${ResearchStore.LIMIT.repository / 1024 / 1024 / 1024} GB`)
  expect([ResearchRate.INTERVAL, ResearchRate.PER_HOST, ResearchRate.OVERALL]).toEqual([1_000, 2, 4])
  expect(page).toContain("one page a second from a site, at most two at a time from one site and four in all")
  expect(page).toContain(`at least ${ResearchQuote.MIN_CHARS} characters`)
  expect(page).toContain(ResearchProvenance.REFUSAL)
  expect(page).toContain(ResearchOutbound.REFUSAL)
  expect(page).toContain(ResearchPlan.READ_APPROVAL)
  expect(page).toContain("Open the page yourself to read the rest with your own sign-in.")
  expect(ResearchPaywall.MESSAGE).toContain("Open the page yourself to read the rest with your own sign-in.")
  // The confidence rule is the one the report's hover gives.
  expect(ResearchConfidence.HOVER).toContain(
    "at least two independent sites with quotes that support the claim, one of them a primary source, and nothing contradicting it",
  )
  expect(page).toContain(
    "Quotes that support the claim from at least two independent sites, one of them a primary source, and nothing contradicting it.",
  )
  // The outbound check checks copied text; the page never says it prevents a leak.
  expect(page).toContain("Vector checks outgoing searches for text from your private files.")
  expect(page).not.toMatch(/\bprevents?\b/i)
})

test("the docs name the search services research can use, and no other", () => {
  // When a search service is added or removed (the browser-search branch removes all three), the research page's
  // Search section and the Vector Local page's forwarding line change with it.
  const services = { searxng: "SearXNG", exa: "Exa", parallel: "Parallel" } as const
  const offered: readonly string[] = ConfigResearchV1.Provider.literals
  for (const [id, name] of Object.entries(services)) {
    expect(text(research).includes(name)).toBe(offered.includes(id))
  }
  expect(text(local).includes("SearXNG")).toBe(offered.includes("searxng"))
})

test("the research page quotes the app's own words", async () => {
  const page = text(research)
  for (const name of ["HELD", "VIEW_ONLY"]) expect(page).toContain(constant(appResearch, name))
  for (const label of ["Web and brain", "Web only", "Brain and files only", "Auto", "Focused", "Deep"])
    expect(appResearch).toContain(`label: "${label}"`)
  const card = await read("packages/app/src/features/research/report-card.tsx")
  for (const action of [
    "Keep in brain",
    "Export",
    "Export JSON",
    "Save to repository",
    "Keep this format",
    "Forget this research",
  ]) {
    expect(card).toContain(`> ${action} <`)
    expect(research).toContain(`<strong>${action}</strong>`)
  }
  expect(appResearch).toContain("return `.vector/research/${date}-${slug}.md`")
  // Research browsers close after their idle time, and the page says how long it is.
  const desktop = await read("packages/desktop/src/main/research-browser.ts")
  expect(desktop).toContain("export const IDLE_MS = 10 * 60_000")
  expect(page).toContain("after 10 idle minutes")
  expect(page).toContain(constant(await read("packages/desktop/src/main/research-navigation.ts"), "POST"))
})

test("the Vector Local page lists what it does not cover in the app's words", async () => {
  const app = await read("packages/app/src/features/local/local-model.ts")
  const covered = [...app.slice(app.indexOf("export const NOT_COVERED")).matchAll(/title: "([^"]+)", body: "([^"]+)"/g)]
    .slice(0, 5)
    .map((match) => [match[1]!, match[2]!])
  expect(covered.map(([title]) => title)).toEqual([
    "Sites you approve",
    "Programs the agent starts",
    "Model and search servers that forward requests",
    "Everything outside Vector",
    "It is a policy inside Vector, not a firewall",
  ])
  for (const [title, body] of covered) {
    expect(local).toContain(`<strong>${title}</strong><span>${body}</span>`)
  }
  // Only the agent's shell tool runs in the sandbox: MCP servers and language servers do not, on any platform.
  const engine = await read("packages/engine/src/tool/shell.ts")
  expect(engine).toContain("Sandbox.offline(input)")
  expect(await read("packages/engine/src/mcp/index.ts")).not.toContain("Sandbox")
  expect(local).toContain("MCP servers and language servers run outside it")
  expect(LocalSources.get("agent-programs")?.note).toContain("run outside the sandbox")
  for (const name of ["NOT_ENCRYPTED", "SHARED_MACHINE", "LOOSENING"])
    expect(text(local).toLowerCase()).toContain(
      constant(app, name)
        .replace(/^Not encrypted: /, "")
        .toLowerCase(),
    )
  expect(text(local)).toContain(constant(app, "FORWARDING").replace(". Vector can't see past it.", ""))
  // What the sandbox lets a command reach on each platform, as the shell tool tells the agent.
  const sandbox = await read("packages/engine/src/tool/shell/sandbox.ts")
  expect(sandbox).toContain("they can reach servers on this computer only")
  expect(sandbox).toContain("they reach no network, not even servers on this computer")
  expect(sandbox).toContain("Install bubblewrap (the bwrap command)")
  expect(sandbox).toContain(
    "they can write only in this repository, the working folder, temporary folders and package caches",
  )
  expect(text(local)).toContain(
    "they can write only in this repository, the working folder, temporary folders and package caches",
  )
})

test("the brain page's roles and budgets are the brain's", async () => {
  const rows = Object.fromEntries(memoryRoleRows)
  expect(rows.Subagents).toContain(`Up to ${Brain.HABITS.subagent} tokens of how you work at every size`)
  expect(rows.Vectorscope).toContain(`Up to ${Brain.HABITS.review} tokens of how you review`)
  expect(rows["Titles, summaries and compaction"]).toBe("Nothing.")
  expect(text(brain)).toContain(`Up to ${Brain.LIMIT.personal} entries about you stay in use`)
  const model = await read("packages/app/src/components/settings-v2/memory-model.ts")
  const agents = model.match(/agents:\s*"([^"]+)"/)?.[1]
  expect(agents).toBeDefined()
  expect(text(brain)).toContain(`{release111.since} every agent uses what Vector has learned about you`)
  expect(agents!).toStartWith("Every agent uses what Vector has learned about you")
  expect(text(brain)).toContain(agents!.replace(/^Every agent/, "every agent"))
  for (const facet of ["Formats", "Workflow", "What you mean", "Tools", "Sources", "Style"])
    expect(model).toContain(`label: "${facet}"`)
  expect(text(brain)).toContain("Formats, Workflow, What you mean, Tools, Sources and Style")
  // Commands the agent runs itself are not checked before they post, and the page says so.
  expect(brain).toContain(
    "Commands the agent runs itself, such as <code>git commit -m</code> or <code>gh pr create</code>, are not checked.",
  )
})

test("the browser agent page's safety notes are the agent browser's", async () => {
  const desktop = await read("packages/desktop/src/main/browser-agent.ts")
  expect(text(browser)).toContain(`{release111.since}`)
  expect(text(browser)).toContain(constant(desktop, "DOWNLOADS_OFF"))
  expect(desktop).toContain('return permission === "fullscreen"')
  expect(await read("packages/engine/src/tool/webfetch.ts")).toContain("return [origin, `${origin}/*`]")
})

test("the models page says how the catalog refreshes, as the engine does", async () => {
  const catalog = await read("packages/core/src/model-catalog.ts")
  expect(catalog).toContain('Schedule.spaced("60 minutes")')
  expect(text(models)).toContain(
    `Vector's mirror, ${ModelCatalog.DEFAULT_MIRROR} , once it has loaded and then every hour`,
  )
  expect(text(models)).not.toContain("--refresh only fetches when a mirror is explicitly configured")
})

test("the 1.99.111 release notes are a draft that says what is not live and what was not run", () => {
  expect(notes).toContain("# Desktop 1.99.111: release notes and owner steps (draft)")
  expect(notes).not.toMatch(/\bTODO\b|\bTBD\b|\bFIXME\b|PLACEHOLDER/)
  // The packet capture and the long local-model run are owner checks until someone has run them.
  expect(notes).toContain("Gate L2")
  expect(notes).toContain("Not run yet")
})

test("the new pages keep to the copy rules", () => {
  for (const page of [research, local, brain, browser, notes].map(text))
    for (const banned of [
      // The word on its own, as test/no-project-wording.test.ts reads it: not part of a path, key or identifier.
      /(?<![\w\-./:#@$[{=])projects?(?![\w\-/\]=}(])(?!\.\w)(?!:\S)/i,
      /\bexactly\b/i,
      /never exceeds/i,
      /absolute privacy/i,
      /controlled only by you/i,
      /shared allowance/i,
      /\bin development\b/i,
    ])
      expect(page).not.toMatch(banned)
})
