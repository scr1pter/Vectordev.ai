import { expect, test } from "bun:test"
import path from "node:path"
import { legacyName } from "@vectordevai/core/flag/legacy"
import { publishedDesktopVersion } from "../src/data/vector-releases"

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

test("the self-evolving agent is labelled as coming in 1.99.110", () => {
  expect(lander).toContain('<p class="story-kicker" data-reveal>Self-evolving · coming in 1.99.110</p>')
  expect(lander).toContain('data-chapter="Self-evolving"')
  // The section says what the brain does, not that it is live.
  expect(lander).not.toMatch(/Vector (now )?(learns|remembers)[^.]*today/i)
})

// When desktop 1.99.110 is published the brain is live, so the section drops its "coming" label.
test.skipIf(Bun.semver.order(publishedDesktopVersion, "1.99.110") < 0)(
  "once desktop 1.99.110 is published, the self-evolving section no longer says it is coming",
  async () => {
    // If the brain slipped past 1.99.110, keep the label and move the version in it instead.
    expect(await Bun.file(path.join(repo, "packages/core/src/brain/brain.ts")).exists()).toBe(true)
    expect(lander).not.toContain("coming in 1.99.110")
  },
)

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
  // Free models on Vector's shared allowance, with may-train models labelled and a one-time question, ship in desktop
  // 1.99.109 with this page.
  expect(lander).toContain("Sign in to Vector and its free models run on Vector's shared allowance")
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
