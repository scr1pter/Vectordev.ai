import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { ExternalAgent } from "@vectordevai/schema/external-agent"
import { mockVectorServer } from "../utils/mock-server"

// Host locally: the launcher for coding agents installed on this computer. The desktop bridge is a fake that reports
// what is installed and records every call, and the engine's terminal is mocked, so no agent CLI, installer or
// account is ever touched.
const directory = "/tmp/vector-host-locally"
const sessionID = "ses_host_locally"
const ptyID = "pty_host_locally"
const shots = process.env.HOST_LOCALLY_SHOTS

type Recorded = { calls: { method: string; input?: unknown }[] }

async function setup(page: Page, options: { detectDelay?: number } = {}) {
  const events: { directory: string; payload: Record<string, unknown> }[] = []
  const ptys: { method: string; body?: Record<string, unknown> }[] = []
  await mockVectorServer(page, {
    directory,
    project: { id: "project-host-locally", worktree: directory, vcs: "git", name: "Agent Fixture" },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        title: "Agent fixture",
        directory,
        projectID: "project-host-locally",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    events: () => events.splice(0, 1),
    eventRetry: 50,
  })
  await page.route(
    (url) => url.pathname === "/pty" || url.pathname.startsWith("/pty/"),
    async (route) => {
      const url = new URL(route.request().url())
      const method = route.request().method()
      const body = route.request().postData()
      ptys.push({ method: `${method} ${url.pathname}`, body: body ? JSON.parse(body) : undefined })
      const payload = url.pathname.endsWith("/connect-token")
        ? { ticket: "e2e-ticket" }
        : { id: ptyID, title: (body && JSON.parse(body).title) || "Terminal" }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(url.pathname === "/pty" && method === "GET" ? [] : payload),
      })
    },
  )
  await page.routeWebSocket(
    (url) => url.pathname === `/pty/${ptyID}/connect`,
    (ws) => ws.send("Installing (fixture)\r\n"),
  )
  await page.addInitScript(
    ({ directory, detectDelay }) => {
      localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem(
        "vector.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      const recorded: Recorded = { calls: [] }
      const installed = new Set(["claude-code", "cursor", "kimi"])
      const detect = async (options?: { refresh?: boolean }) => {
        recorded.calls.push({ method: "detect", input: options })
        if (detectDelay) await new Promise((resolve) => setTimeout(resolve, detectDelay))
        const row = (id: string, name: string, cli: string, tier: string, fields: Record<string, unknown>) => ({
          id,
          name,
          cli,
          tier,
          ...fields,
        })
        return [
          row("claude-code", "Claude Code", "claude", "chat", {
            state: "ready",
            installed: true,
            signedIn: true,
            version: "2.1.215",
          }),
          row("codex", "Codex", "codex", "chat", { state: "not-installed", installed: false }),
          row("cursor", "Cursor CLI", "agent", "chat", { state: "signed-out", installed: true, signedIn: false }),
          row(
            "gemini",
            "Gemini CLI",
            "gemini",
            "chat",
            installed.has("gemini")
              ? { state: "unknown", installed: true }
              : { state: "not-installed", installed: false },
          ),
          row("kilo", "Kilo CLI", "kilo", "terminal", { state: "not-installed", installed: false }),
          row("kimi", "Kimi Code", "kimi", "terminal", { state: "unknown", installed: true, version: "1.0.6" }),
        ]
      }
      const launch = (title: string, display: string) => ({
        title,
        display,
        command: "/bin/sh",
        args: ["-c", `${display}\nstatus=$?\nread -r _\nexit "$status"`],
        cwd: "/fixture/external-agent-setup",
        env: { PATH: "/usr/bin:/bin" },
      })
      const api = {
        parallelWorkspaces: {
          list: async () => [],
          create: async (input: unknown) => {
            recorded.calls.push({ method: "create", input })
            throw new Error("fixture stops before provisioning")
          },
        },
        externalAgents: {
          detect,
          commands: async (id: string) => {
            recorded.calls.push({ method: "commands", input: id })
            if (id === "gemini")
              return {
                id,
                platform: "darwin",
                docsUrl: "https://github.com/google-gemini/gemini-cli",
                install: [
                  {
                    id: "npm",
                    label: "npm",
                    platforms: ["darwin", "linux", "win32"],
                    command: "npm install -g @google/gemini-cli",
                    docsUrl: "https://github.com/google-gemini/gemini-cli",
                    launch: launch("Install Gemini CLI", "npm install -g @google/gemini-cli"),
                  },
                  {
                    id: "homebrew",
                    label: "Homebrew",
                    platforms: ["darwin", "linux"],
                    command: "brew install gemini-cli",
                    docsUrl: "https://github.com/google-gemini/gemini-cli",
                    launch: launch("Install Gemini CLI", "brew install gemini-cli"),
                  },
                ],
              }
            if (id === "cursor")
              return {
                id,
                platform: "darwin",
                docsUrl: "https://cursor.com/docs/cli/overview",
                install: [],
                signIn: {
                  display: "agent login",
                  interactive: false,
                  launch: launch("Sign in to Cursor CLI", "agent login"),
                },
              }
            return { id, platform: "darwin", docsUrl: "https://example.invalid", install: [] }
          },
          models: async (id: string) => {
            recorded.calls.push({ method: "models", input: id })
            return { id, source: "catalog", models: [] }
          },
          launchTerminal: async (input: { id: string; projectPath: string; model?: string }) => {
            recorded.calls.push({ method: "launchTerminal", input })
            return {
              workspace: { path: `${input.projectPath}-isolated`, isolation: "git-worktree" },
              launch: {
                ...launch(input.id === "kimi" ? "Kimi Code" : "Claude Code", input.id === "kimi" ? "kimi" : "claude"),
                cwd: `${input.projectPath}-isolated`,
              },
            }
          },
        },
        recorded: () => recorded,
        install: (id: string) => installed.add(id),
      }
      Object.defineProperty(window, "api", { configurable: true, value: api })
    },
    { directory, detectDelay: options.detectDelay ?? 0 },
  )
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await page.getByRole("button", { name: "New workspace", exact: true }).click()
  const launcher = page.getByRole("dialog", { name: "New isolated agent" })
  await expect(launcher).toBeVisible()
  return { launcher, events, ptys }
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { api: { recorded: () => Recorded } }).api.recorded().calls)

async function openHost(page: Page) {
  await page.locator("[data-vector-host-locally-tile]").click()
  const host = page.getByRole("dialog", { name: "Coding agents" })
  await expect(host).toBeVisible()
  return host
}

test("Host locally lists every coding agent with its badge and its status on this computer", async ({ page }) => {
  const fixture = await setup(page)
  // The agent launcher has one tile for every coding agent, which counts the ones that can start.
  await expect(fixture.launcher.locator("[data-vector-host-locally-tile]")).toHaveAccessibleName(
    "Host locally: 2 of 15 ready to start",
  )
  if (shots) await fixture.launcher.screenshot({ path: `${shots}/launcher-tiles.png` })
  const host = await openHost(page)
  const rows = host.locator('[data-slot="host-row"]')
  await expect(rows).toHaveCount(15)
  await expect(host.locator('[data-slot="host-section"]')).toContainText("Host locally")
  await expect(host.locator('[data-slot="host-row"][data-agent-id="antigravity"]')).toHaveCount(0)

  // Neutral letters for every agent: no vendor's logo or icon is drawn, Cursor's and Kilo's included.
  const row = (id: string) => host.locator(`[data-slot="host-row"][data-agent-id="${id}"]`)
  await expect(row("claude-code").locator('[data-component="agent-badge"]')).toHaveText("CC")
  await expect(row("codex").locator('[data-component="agent-badge"]')).toHaveText("CX")
  await expect(row("muse-code").locator('[data-component="agent-badge"]')).toHaveText("MC")
  await expect(row("cursor").locator('[data-component="agent-badge"]')).toHaveText("CU")
  await expect(row("kilo").locator('[data-component="agent-badge"]')).toHaveText("KI")
  expect(await host.locator('[data-component="agent-badge"] img, [data-component="agent-badge"] svg').count()).toBe(0)
  // Names as their vendors write them.
  await expect(row("cursor").locator('[data-slot="host-row-name"]')).toHaveText("Cursor CLI")
  await expect(row("kilo").locator('[data-slot="host-row-name"]')).toHaveText("Kilo CLI")
  await expect(row("junie").locator('[data-slot="host-row-name"]')).toHaveText("Junie")
  await expect(row("goose").locator('[data-slot="host-row-name"]')).toHaveText("goose")
  // The fine print: independent, not affiliated, and the names are their owners' trademarks.
  const footnote = host.locator('[data-slot="host-footnote"]')
  await expect(footnote).toContainText("Vector is independent and is not affiliated with, endorsed by or sponsored by")
  await expect(footnote).toContainText("Their names are trademarks of their owners.")
  await expect(footnote).not.toContainText("logos")

  const status = (id: string) => row(id).locator('[data-component="agent-status"]')
  await expect(status("claude-code")).toHaveText("Ready")
  await expect(status("cursor")).toHaveText("Signed out")
  await expect(status("codex")).toHaveText("Not installed")
  await expect(status("kimi")).toHaveText("Unknown")
  // Detected by no fake: never shown as missing.
  await expect(status("junie")).toHaveText("Unknown")
  await expect(row("gemini")).toContainText("Work or API accounts")
  await expect(row("kimi").locator('[data-slot="host-tag"]', { hasText: "Terminal" })).toBeVisible()
  if (shots) await host.screenshot({ path: `${shots}/launcher-list.png` })

  // Search filters by name, vendor and command.
  const search = host.getByRole("searchbox", { name: "Search coding agents" })
  await search.fill("google")
  await expect(rows).toHaveCount(1)
  await expect(rows.nth(0)).toContainText("Gemini CLI")
  await search.fill("agy")
  await expect(rows).toHaveCount(0)
  await search.fill("cursor-agent")
  await expect(rows).toHaveCount(1)
  await search.fill("no agent is called this")
  await expect(rows).toHaveCount(0)
  await expect(host).toContainText('No coding agents match "no agent is called this".')
  await search.fill("")
  await expect(rows).toHaveCount(15)

  // Refresh detects past desktop's cache.
  await host.getByRole("button", { name: "Check this computer again" }).click()
  await expect
    .poll(async () => (await calls(page)).filter((call) => call.method === "detect").at(-1)?.input)
    .toEqual({
      refresh: true,
    })
})

test("a row that is still being checked says so", async ({ page }) => {
  await setup(page, { detectDelay: 60_000 })
  const host = await openHost(page)
  await expect(
    host.locator('[data-slot="host-row"][data-agent-id="claude-code"] [data-component="agent-status"]'),
  ).toHaveText("Checking")
})

test("a missing agent shows its official install command and runs nothing until asked", async ({ page }) => {
  const fixture = await setup(page)
  const host = await openHost(page)
  await host.getByRole("button", { name: /^Gemini CLI,/ }).click()
  const install = host.getByRole("region", { name: "Install" })
  await expect(install.locator('[data-slot="host-command"]')).toHaveText("npm install -g @google/gemini-cli")
  await expect(install.getByRole("link", { name: "github.com/google-gemini/gemini-cli" })).toHaveAttribute(
    "href",
    "https://github.com/google-gemini/gemini-cli",
  )
  await expect(host.getByRole("list", { name: "Billing and terms" })).toContainText(
    "Gemini Code Assist Standard or Enterprise licence. Otherwise it needs a Gemini API key.",
  )
  await install.getByRole("button", { name: "Homebrew" }).click()
  await expect(install.locator('[data-slot="host-command"]')).toHaveText("brew install gemini-cli")
  await install.getByRole("button", { name: "npm" }).click()
  if (shots) await host.screenshot({ path: `${shots}/launcher-install.png` })

  // Showing the command started nothing.
  await page.waitForTimeout(300)
  expect(fixture.ptys.filter((call) => call.method === "POST /pty")).toEqual([])

  await host.getByRole("button", { name: "Run in terminal", exact: true }).click()
  await expect.poll(() => fixture.ptys.filter((call) => call.method === "POST /pty").length).toBe(1)
  const created = fixture.ptys.find((call) => call.method === "POST /pty")!.body!
  expect(created).toMatchObject({
    title: "Install Gemini CLI",
    command: "/bin/sh",
    cwd: "/fixture/external-agent-setup",
  })
  expect(String((created.args as string[])[1])).toContain("npm install -g @google/gemini-cli")
  await expect(host.getByRole("region", { name: "Install Gemini CLI terminal" })).toBeVisible()
  await expect(host.locator('[data-component="terminal"]')).toBeVisible()

  // The installer finishes; Vector detects again past its cache and finds the agent.
  const before = (await calls(page)).filter((call) => call.method === "detect").length
  await page.evaluate(() => (window as unknown as { api: { install: (id: string) => void } }).api.install("gemini"))
  fixture.events.push({ directory, payload: { type: "pty.exited", properties: { id: ptyID, exitCode: 0 } } })
  await expect.poll(async () => (await calls(page)).filter((call) => call.method === "detect").length).toBe(before + 1)
  expect((await calls(page)).filter((call) => call.method === "detect").at(-1)?.input).toEqual({ refresh: true })
  await expect(host.locator('[data-slot="host-detail"] [data-component="agent-status"]')).toHaveText("Unknown")
  await expect(host.getByRole("button", { name: "Use Gemini CLI", exact: true })).toBeVisible()
})

test("a ready agent starts with the model chosen in Host locally", async ({ page }) => {
  const fixture = await setup(page)
  const host = await openHost(page)
  await host.getByRole("button", { name: /^Claude Code,/ }).click()
  await expect(host.getByRole("region", { name: "Start" })).toBeVisible()
  await expect(host).toContainText(
    "Runs your installed Claude Code in Vector's chat, in an isolated copy of the repository.",
  )
  const control = host.getByRole("button", { name: "Claude Code model: Agent default", exact: true })
  await control.click()
  // The catalog's models open in place, inside the dialog, with the agent's own default checked.
  const models = host.getByRole("radiogroup", { name: "Claude Code models" })
  await expect(models.getByRole("radio", { name: "Agent default" })).toBeChecked()
  const claude = ExternalAgent.find("claude-code")!
  await expect(models.getByRole("radio")).toHaveCount(
    1 + (claude.models.kind === "fixed" ? claude.models.models.length : 0),
  )
  if (shots) await host.screenshot({ path: `${shots}/launcher-ready.png` })
  await models.getByRole("radio", { name: /^Sonnet \(latest\)/ }).click()
  await expect(models).toHaveCount(0)
  await expect(host.getByRole("button", { name: "Claude Code model: Sonnet (latest)", exact: true })).toBeVisible()
  await expect(host.getByRole("textbox", { name: "Custom model ID" })).toBeVisible()

  // A custom id that could read as a flag is refused before anything runs.
  await host.getByRole("textbox", { name: "Custom model ID" }).fill("--yolo")
  await expect(host.getByRole("button", { name: "Use Claude Code", exact: true })).toBeDisabled()
  await host.getByRole("textbox", { name: "Custom model ID" }).fill("")

  await host.getByRole("button", { name: "Use Claude Code", exact: true }).click()
  await expect(host).toHaveCount(0)
  await expect(fixture.launcher.getByRole("button", { name: /^Host locally: Claude Code/ })).toBeVisible()
  await expect(
    fixture.launcher.getByRole("button", { name: "Claude Code model: Sonnet (latest)", exact: true }),
  ).toBeVisible()
  if (shots) await fixture.launcher.screenshot({ path: `${shots}/launcher-tile.png` })
  await fixture.launcher.getByLabel("Agent instructions").fill("Tidy the search module.")
  await fixture.launcher.getByRole("button", { name: "Launch agent", exact: true }).click()
  await expect
    .poll(async () =>
      (await calls(page))
        .filter((call) => call.method === "create")
        .map((call) => {
          const input = call.input as { runtime?: string; runtimeModel?: string }
          return [input.runtime, input.runtimeModel]
        }),
    )
    .toEqual([["claude-code", "sonnet"]])
})

test("a signed-out agent signs in with its own command in Vector's terminal", async ({ page }) => {
  const fixture = await setup(page)
  const host = await openHost(page)
  await host.getByRole("button", { name: /^Cursor CLI,/ }).click()
  const signIn = host.getByRole("region", { name: "Sign in" })
  await expect(signIn.locator('[data-slot="host-command"]')).toHaveText("agent login")
  expect(fixture.ptys.filter((call) => call.method === "POST /pty")).toEqual([])
  await host.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect.poll(() => fixture.ptys.filter((call) => call.method === "POST /pty").length).toBe(1)
  expect(fixture.ptys.find((call) => call.method === "POST /pty")!.body).toMatchObject({
    title: "Sign in to Cursor CLI",
  })
  // Before the first run: what --force and --trust allow, and where.
  await expect(host.getByRole("list", { name: "Billing and terms" })).toContainText(
    "In Vector's chat, Cursor CLI runs with --force and --trust, which let it change files and run commands without asking.",
  )
})

test("an agent's notes carry its vendor's trademark notice and the terms the user needs before the first run", async ({
  page,
}) => {
  await setup(page)
  const host = await openHost(page)
  const notes = host.getByRole("list", { name: "Billing and terms" })

  await host.getByRole("button", { name: /^Junie,/ }).click()
  await expect(notes).toContainText("Junie is a trademark of JetBrains s.r.o.")
  await expect(notes.getByRole("link", { name: "www.jetbrains.com" })).toHaveAttribute(
    "href",
    "https://www.jetbrains.com/",
  )
  if (shots) await host.screenshot({ path: `${shots}/launcher-trademark.png` })
  await host.getByRole("button", { name: "Back to coding agents" }).click()

  await host.getByRole("button", { name: /^goose,/ }).click()
  await expect(notes).toContainText("goose is a trademark of LF Projects, LLC.")
  await host.getByRole("button", { name: "Back to coding agents" }).click()

  await host.getByRole("button", { name: /^Muse Code,/ }).click()
  await expect(notes).toContainText("turn Contributor mode off before the first run")
  await host.getByRole("button", { name: "Back to coding agents" }).click()

  await host.getByRole("button", { name: /^pi,/ }).click()
  await expect(notes).toContainText("Anthropic's terms restrict Claude Pro/Max sign-in in third-party tools")
  await host.getByRole("button", { name: "Back to coding agents" }).click()

  await host.getByRole("button", { name: /^Qwen Code,/ }).click()
  await expect(notes).toContainText("Qwen Code isn't free")
  await expect(notes).toContainText("Alibaba limits Coding Plan and Token Plan keys to interactive use.")
  if (shots) await host.screenshot({ path: `${shots}/launcher-notes.png` })
})

test("a chat agent can start in the terminal instead, with the model chosen for it", async ({ page }) => {
  const fixture = await setup(page)
  const host = await openHost(page)
  await host.getByRole("button", { name: /^Claude Code,/ }).click()
  await expect(host.getByRole("list", { name: "Billing and terms" })).toContainText(
    "an ANTHROPIC_API_KEY set in your environment is used before your subscription",
  )
  if (shots) await host.screenshot({ path: `${shots}/launcher-detail.png` })
  await host.getByRole("button", { name: "Claude Code model: Agent default", exact: true }).click()
  await host
    .getByRole("radiogroup", { name: "Claude Code models" })
    .getByRole("radio", { name: /^Sonnet \(latest\)/ })
    .click()
  await host.getByRole("button", { name: "Start in terminal", exact: true }).click()
  await expect
    .poll(async () => (await calls(page)).filter((call) => call.method === "launchTerminal").map((call) => call.input))
    .toEqual([{ id: "claude-code", projectPath: directory, model: "sonnet" }])
  await expect.poll(() => fixture.ptys.filter((call) => call.method === "POST /pty").length).toBe(1)
  expect(fixture.ptys.find((call) => call.method === "POST /pty")!.body).toMatchObject({ title: "Claude Code" })
  await expect(host).toHaveCount(0)
  // Nothing was set to run in Vector's chat.
  expect((await calls(page)).filter((call) => call.method === "create")).toEqual([])
})

test("a terminal agent starts in the session's terminal, in its isolated copy", async ({ page }) => {
  const fixture = await setup(page)
  const host = await openHost(page)
  await host.getByRole("button", { name: /^Kimi Code,/ }).click()
  await expect(host).toContainText("Runs your installed Kimi Code in Vector's terminal")
  await expect(host).toContainText("Choose the model inside Kimi Code.")
  // A terminal agent has one way to start.
  await expect(host.getByRole("button", { name: "Start in terminal", exact: true })).toHaveCount(0)
  await host.getByRole("button", { name: "Start Kimi Code", exact: true }).click()
  await expect
    .poll(async () => (await calls(page)).filter((call) => call.method === "launchTerminal").map((call) => call.input))
    .toEqual([{ id: "kimi", projectPath: directory, model: undefined }])
  await expect.poll(() => fixture.ptys.filter((call) => call.method === "POST /pty").length).toBe(1)
  expect(fixture.ptys.find((call) => call.method === "POST /pty")!.body).toMatchObject({
    title: "Kimi Code",
    cwd: `${directory}-isolated`,
  })
  await expect(host).toHaveCount(0)
  await expect(page.locator("#terminal-panel")).toHaveAttribute("aria-hidden", "false")
})
