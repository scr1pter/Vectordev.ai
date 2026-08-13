import { chromium, type Page } from "@playwright/test"

const origin = process.env.VECTOR_QA_ORIGIN || "http://127.0.0.1:4321"
const output = process.env.VECTOR_QA_OUTPUT || "/tmp"
const now = new Date().toISOString()

const session = {
  access_token: "visual-qa-token",
  refresh_token: "visual-qa-refresh",
  token_type: "bearer",
  expires_in: 86_400,
  expires_at: Math.floor(Date.now() / 1000) + 86_400,
  user: {
    id: "visual-qa-user",
    aud: "authenticated",
    role: "authenticated",
    email: "builder@vectordev.ai",
    user_metadata: { full_name: "Vector Builder" },
    app_metadata: { provider: "email" },
    created_at: now,
  },
}

const project = {
  id: "project-launchpad",
  name: "Launchpad",
  description: "A polished product launch dashboard",
  status: "active",
  created_at: now,
  updated_at: now,
}

const run = {
  id: "run-launchpad",
  project_id: project.id,
  name: "Build launch dashboard",
  prompt: "Build a polished launch dashboard with milestones, metrics, and a responsive timeline.",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
  status: "complete",
  current_step: "Application built and verified",
  selected_tools: ["github"],
  summary: "Created the dashboard, added responsive states, and verified the production build.",
  logs: "Build complete",
  diff_stats: {
    changedFiles: 4,
    additions: 286,
    deletions: 18,
    files: [
      { path: "src/App.tsx", added: 112, deleted: 8 },
      { path: "src/styles.css", added: 124, deleted: 10 },
      { path: "src/components/Timeline.tsx", added: 42, deleted: 0 },
      { path: "package.json", added: 8, deleted: 0 },
    ],
  },
  error: null,
  cost_usd: 0.0248,
  token_usage: { input: 4480, output: 1520 },
  preview_url: null,
  preview_status: "failed",
  started_at: new Date(Date.now() - 73_000).toISOString(),
  completed_at: now,
  created_at: now,
  updated_at: now,
}

const messages = [
  { id: "message-user", role: "user", content: run.prompt, created_at: now },
  {
    id: "message-vector",
    role: "assistant",
    content:
      "I built the responsive launch dashboard, connected the milestone timeline, and verified the production build. The generated app is ready to preview or refine.",
    created_at: now,
  },
]

function json(route: Parameters<Page["route"]>[1] extends (route: infer R) => unknown ? R : never, body: unknown) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
}

async function prepare(page: Page) {
  await page.addInitScript((value) => {
    localStorage.setItem("sb-vectorqa-auth-token", JSON.stringify(value))
  }, session)
  await page.route("**/api/platform/config", (route) =>
    json(route, {
      auth: {
        available: true,
        url: "https://vectorqa.supabase.co",
        publishableKey: "visual-qa-key",
        providers: ["google"],
      },
      services: { builder: true, billing: true },
      builderModel: "openrouter/openrouter/free",
      limits: { activeBuilderRuns: 8, builderLaunches30Days: 24, builderTurns30Days: 240 },
      plans: [
        { id: "monthly", priceUsd: 10, interval: "month", graceDays: 3 },
        { id: "annual", priceUsd: 99, interval: "year", graceDays: 0 },
      ],
    }),
  )
  await page.route("https://vectorqa.supabase.co/**", (route) =>
    json(route, { user: session.user }),
  )
  await page.route("**/api/account/status", (route) =>
    json(route, {
      entitlement: { access: true, state: "active" },
      billing: { available: true },
    }),
  )
  await page.route("**/api/builder/projects", (route) => json(route, { projects: [project] }))
  await page.route("**/api/builder/runs", (route) =>
    json(route, { runs: [run], models: ["openrouter/openrouter/free"] }),
  )
  await page.route("**/api/builder/run?**", (route) => json(route, { run, messages }))
  await page.route("**/api/platform/providers", (route) =>
    json(route, {
      connections: [
        {
          id: "provider-anthropic",
          provider_id: "anthropic",
          name: "Claude",
          models: ["claude-sonnet-4-5"],
          enabled: true,
        },
      ],
    }),
  )
  await page.route("**/api/platform/connections", (route) =>
    json(route, {
      connections: [
        { id: "github", plugin_id: "github", name: "GitHub", kind: "plugin", enabled: true },
        { id: "computer", plugin_id: "computer-use", name: "Krishna's Mac", kind: "plugin", enabled: true },
      ],
    }),
  )
}

const browser = await chromium.launch({ headless: true })
try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 })
  await prepare(desktop)
  await desktop.goto(origin + "/account", { waitUntil: "networkidle" })
  await desktop.locator(".builder-dashboard").waitFor()
  await desktop.screenshot({ path: output + "/vector-builder-dashboard.png", fullPage: true })
  await desktop.getByRole("button", { name: /Launchpad/ }).first().click()
  await desktop.locator(".builder-workspace").waitFor()
  await desktop.screenshot({ path: output + "/vector-builder-workspace.png", fullPage: true })

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })
  await prepare(mobile)
  await mobile.goto(origin + "/account", { waitUntil: "networkidle" })
  await mobile.locator(".builder-dashboard").waitFor()
  await mobile.screenshot({ path: output + "/vector-builder-mobile.png", fullPage: true })
} finally {
  await browser.close()
}
