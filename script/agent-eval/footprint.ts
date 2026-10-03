#!/usr/bin/env bun
// Offline request-cost benchmark. Runs a real agent (Vector's `vector run`, or the Claude Code CLI) against a local
// fake Anthropic Messages server that plays a fixed script of tool calls, records every request the agent sends, and
// prices each one under Anthropic's prompt-caching rules. No API key, no network and no model variance: the same
// build always produces the same numbers, and two runtimes doing the same steps can be compared exactly. It measures
// what each runtime sends, not how well a model would do with it; the live harness in run.ts measures that.
//
//   bun script/agent-eval/footprint.ts                              Vector, every scenario
//   bun script/agent-eval/footprint.ts --runtime vector,claude-code side by side
//   bun script/agent-eval/footprint.ts --scenario solo-fix --out report.json

import { spawn, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { taskById } from "./tasks"

const REPO_ROOT = resolve(import.meta.dir, "../..")
const ENGINE = join(REPO_ROOT, "packages", "engine", "src", "index.ts")
const MODEL = "claude-sonnet-4-5"
// Claude Sonnet 4.5 list prices per million tokens; a 5-minute cache write costs 1.25x input, a read 0.1x.
const PRICE = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 }
// Anthropic caches nothing shorter than this, and looks back at most this many blocks from a breakpoint for a hit.
const MIN_CACHEABLE_TOKENS = 1_024
const LOOKBACK_BLOCKS = 20

type Runtime = "vector" | "claude-code"
const RUNTIMES: Runtime[] = ["vector", "claude-code"]

// A runtime-neutral step. Each runtime gets it as a call to its own tool for the job, so both do the same work.
type Step =
  | { kind: "bash"; command: string; description: string }
  | { kind: "read"; path: string }
  | { kind: "edit"; path: string; from: string; to: string }
  | { kind: "search"; pattern: string }
  | { kind: "list"; pattern: string }
  | { kind: "delegate"; agent: "explore" | "general"; description: string; prompt: string }
  | { kind: "answer"; text: string }

type Scenario = { id: string; title: string; task: string; steps: Step[] }

const FIX: Step = { kind: "edit", path: "src/invoice.ts", from: "invoice.dueOn <= today", to: "invoice.dueOn < today" }
const TEST: Step = { kind: "bash", command: "bun test", description: "Run the test suite" }

const SCENARIOS: Scenario[] = [
  {
    id: "solo-fix",
    title: "Fix a failing test alone: run the suite, read, edit, re-run, answer",
    task: "bugfix-overdue-invoices",
    steps: [
      TEST,
      { kind: "read", path: "src/invoice.ts" },
      FIX,
      TEST,
      { kind: "answer", text: "Fixed: an invoice due today is no longer counted as overdue. The whole suite passes." },
    ],
  },
  {
    id: "delegate-explore",
    title: "Hand the search to a read-only explore subagent, then fix and verify",
    task: "bugfix-overdue-invoices",
    steps: [
      {
        kind: "delegate",
        agent: "explore",
        description: "find the failing boundary",
        prompt: "Find why `bun test` fails in this repository. Report the file, the line and the cause.",
      },
      // The subagent's own steps.
      { kind: "search", pattern: "dueOn" },
      { kind: "read", path: "src/invoice.ts" },
      {
        kind: "answer",
        text: "src/invoice.ts line 5: `invoice.dueOn <= today` counts an invoice due today as overdue.",
      },
      // Back in the parent.
      { kind: "read", path: "src/invoice.ts" },
      FIX,
      TEST,
      { kind: "answer", text: "Fixed the boundary in src/invoice.ts; the suite passes." },
    ],
  },
  {
    id: "delegate-general",
    title: "Hand the whole fix to a general subagent, then check its work",
    task: "bugfix-overdue-invoices",
    steps: [
      {
        kind: "delegate",
        agent: "general",
        description: "fix the failing boundary",
        prompt: "Make `bun test` pass in this repository without editing test/. Report the change and the test run.",
      },
      // The subagent's own steps.
      TEST,
      { kind: "read", path: "src/invoice.ts" },
      FIX,
      TEST,
      { kind: "answer", text: "Changed `<=` to `<` in src/invoice.ts line 5; `bun test` passes (3 tests)." },
      // Back in the parent.
      TEST,
      { kind: "answer", text: "Fixed the boundary in src/invoice.ts; the suite passes." },
    ],
  },
  {
    id: "long-loop",
    title: "A 12-step investigation: how the prompt cache holds up as a tool loop grows",
    task: "discipline-single-file-fix",
    steps: [
      TEST,
      { kind: "list", pattern: "**/*.ts" },
      { kind: "read", path: "README.md" },
      { kind: "search", pattern: "export function" },
      { kind: "read", path: "src/args.ts" },
      { kind: "read", path: "src/logger.ts" },
      { kind: "read", path: "src/config.ts" },
      { kind: "search", pattern: "TODO" },
      { kind: "bash", command: "git status --short", description: "Check the working tree" },
      TEST,
      { kind: "list", pattern: "test/**/*.ts" },
      { kind: "answer", text: "Investigation finished; the failing case is in src/args.ts." },
    ],
  },
]

// The call each runtime makes for a step, with its own tool names and parameters. Claude Code has no separate search
// or list tool, so those run through Bash with ripgrep, as it does them.
function toolCall(
  runtime: Runtime,
  step: Step,
  dir: string,
): { name: string; input: Record<string, unknown> } | { text: string } {
  const path = (relative: string) => join(dir, relative)
  if (step.kind === "answer") return { text: step.text }
  if (runtime === "vector") {
    if (step.kind === "bash") return { name: "bash", input: { command: step.command, description: step.description } }
    if (step.kind === "read") return { name: "read", input: { filePath: path(step.path) } }
    if (step.kind === "edit")
      return { name: "edit", input: { filePath: path(step.path), oldString: step.from, newString: step.to } }
    if (step.kind === "search") return { name: "grep", input: { pattern: step.pattern, path: dir } }
    if (step.kind === "list") return { name: "glob", input: { pattern: step.pattern } }
    return {
      name: "task",
      input: { description: step.description, prompt: step.prompt, subagent_type: step.agent },
    }
  }
  if (step.kind === "bash") return { name: "Bash", input: { command: step.command, description: step.description } }
  if (step.kind === "read") return { name: "Read", input: { file_path: path(step.path) } }
  if (step.kind === "edit")
    return { name: "Edit", input: { file_path: path(step.path), old_string: step.from, new_string: step.to } }
  if (step.kind === "search")
    return {
      name: "Bash",
      input: { command: `rg -n ${JSON.stringify(step.pattern)} .`, description: "Search the code" },
    }
  if (step.kind === "list")
    return {
      name: "Bash",
      input: { command: `rg --files -g ${JSON.stringify(step.pattern)}`, description: "List files" },
    }
  return {
    name: "Agent",
    input: {
      description: step.description,
      prompt: step.prompt,
      subagent_type: step.agent === "explore" ? "Explore" : "general-purpose",
    },
  }
}

type Recorded = { body: Record<string, unknown>; output: string }

type Block = { key: string; tokens: number; breakpoint: boolean }

type RequestCost = {
  index: number
  who: "agent" | "subagent" | "side"
  tools: number
  systemTokens: number
  toolTokens: number
  messageTokens: number
  inputTokens: number
  cacheRead: number
  cacheWrite: number
  uncached: number
  outputTokens: number
  costUsd: number
  uncachedCostUsd: number
}

const flags = parseFlags(process.argv.slice(2))
const scenarios = flags.scenario ? SCENARIOS.filter((scenario) => scenario.id === flags.scenario) : SCENARIOS
if (scenarios.length === 0) {
  process.stderr.write(
    `Unknown scenario ${flags.scenario}. Scenarios: ${SCENARIOS.map((item) => item.id).join(", ")}\n`,
  )
  process.exit(2)
}
const runtimes = (flags.runtime ?? "vector").split(",").map((item) => item.trim())
const unknown = runtimes.filter((item) => !RUNTIMES.includes(item as Runtime))
if (unknown.length > 0) {
  process.stderr.write(`Unknown runtime ${unknown.join(", ")}. Runtimes: ${RUNTIMES.join(", ")}\n`)
  process.exit(2)
}

const reports: Array<Record<string, unknown>> = []
for (const scenario of scenarios) {
  for (const runtime of runtimes as Runtime[]) {
    process.stderr.write(`\n=== ${runtime} · ${scenario.id}: ${scenario.title} ===\n`)
    if (runtime === "claude-code" && spawnSync("claude", ["--version"]).status !== 0) {
      process.stderr.write("  unavailable: the claude CLI is not on PATH\n")
      reports.push({ scenario: scenario.id, runtime, unavailable: true })
      continue
    }
    const recorded = await runScenario(scenario, runtime)
    if ("error" in recorded) {
      process.stderr.write(`  failed: ${recorded.error}\n`)
      reports.push({ scenario: scenario.id, runtime, error: recorded.error })
      continue
    }
    const costs = price(recorded.requests)
    const definitions = toolDefinitions(recorded.requests)
    process.stdout.write(
      `\n${runtime} · ${scenario.id} — ${scenario.title}\n${render(costs)}\n${renderDefinitions(definitions)}\n`,
    )
    reports.push({
      scenario: scenario.id,
      runtime,
      exitCode: recorded.exitCode,
      unplayed: recorded.unplayed,
      requests: costs,
      totals: totals(costs),
      toolDefinitions: definitions,
    })
  }
}
if (runtimes.length > 1) process.stdout.write(`\nSide by side\n${renderComparison(reports)}\n`)

const out = flags.out ?? join(tmpdir(), `vector-footprint-${Date.now()}.json`)
await writeFile(out, JSON.stringify({ model: MODEL, price: PRICE, scenarios: reports }, null, 2) + "\n")
process.stdout.write(`\nJSON report: ${out}\n`)

async function runScenario(scenario: Scenario, runtime: Runtime) {
  const task = taskById(scenario.task)
  if (!task) return { error: `unknown task ${scenario.task}` }
  const root = await mkdtemp(join(tmpdir(), "vector-footprint-"))
  const dir = join(root, "repo")
  const home = join(root, "home")
  await mkdir(home, { recursive: true })
  await Promise.all(
    Object.entries(task.files).map(async ([path, content]) => {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }),
  )
  const identity = ["-c", "user.name=Bench", "-c", "user.email=bench@vector.local"]
  await exec("git", ["-c", "init.defaultBranch=bench", "init", "--quiet"], dir)
  await exec("git", [...identity, "add", "-A"], dir)
  await exec("git", [...identity, "commit", "--quiet", "-m", "baseline"], dir)

  const calls = scenario.steps.map((step) => toolCall(runtime, step, dir))
  const requests: Recorded[] = []
  let id = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: estimate(JSON.stringify(body)) })
      if (!url.pathname.endsWith("/messages")) return Response.json({})
      const tools = Array.isArray(body.tools) ? body.tools : []
      // Requests without tools are side calls such as title generation; they do not advance the script.
      const call = tools.length === 0 ? { text: "Bench task" } : (calls.shift() ?? { text: "Done." })
      requests.push({ body, output: "name" in call ? JSON.stringify(call.input) : call.text })
      if (body.stream !== true) return Response.json(message(call, `toolu_${++id}`, String(body.model ?? MODEL)))
      return new Response(stream(call, `toolu_${++id}`, String(body.model ?? MODEL)), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  const result =
    runtime === "vector"
      ? await exec("bun", vectorArgs(task.prompt), dir, vectorEnv(home, base))
      : await exec("claude", claudeArgs(task.prompt), dir, claudeEnv(home, base), true)
  server.stop(true)
  if (!flags.keep) await rm(root, { recursive: true, force: true })
  if (requests.length === 0)
    return { error: `the agent sent no requests (exit ${result.exitCode}): ${result.output.slice(-800)}` }
  if (calls.length > 0) process.stderr.write(`  note: ${calls.length} scripted step(s) were never requested\n`)
  return { exitCode: result.exitCode, requests, unplayed: calls.length }
}

function vectorArgs(prompt: string) {
  return [
    "run",
    "--conditions=browser",
    ENGINE,
    "run",
    "--format",
    "json",
    "--model",
    `anthropic/${MODEL}`,
    "--dangerously-skip-permissions",
    prompt,
  ]
}

function vectorEnv(home: string, base: string) {
  const config = {
    formatter: false,
    lsp: false,
    provider: {
      anthropic: {
        name: "Anthropic",
        id: "anthropic",
        env: [],
        npm: "@ai-sdk/anthropic",
        models: {
          [MODEL]: {
            id: MODEL,
            name: "Claude Sonnet 4.5",
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            release_date: "2025-09-29",
            limit: { context: 200_000, output: 64_000 },
            cost: {
              input: PRICE.input,
              output: PRICE.output,
              cache_read: PRICE.cacheRead,
              cache_write: PRICE.cacheWrite,
            },
            options: {},
          },
        },
        options: { apiKey: "bench", baseURL: `${base}/v1` },
      },
    },
  }
  return {
    VECTOR_TEST_HOME: home,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    VECTOR_CONFIG_CONTENT: JSON.stringify(config),
    VECTOR_DISABLE_PROJECT_CONFIG: "1",
    VECTOR_PURE: "1",
    VECTOR_DISABLE_AUTOUPDATE: "1",
    VECTOR_DISABLE_MODELS_FETCH: "1",
    VECTOR_AUTH_CONTENT: "{}",
  }
}

function claudeArgs(prompt: string) {
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    MODEL,
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash,Read,Edit,Agent",
  ]
}

// Claude Code starts with nothing from the calling environment but PATH, so it neither picks up a session it was
// launched from nor any real credentials: it talks only to the fake server, with a key that server ignores.
function claudeEnv(home: string, base: string) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TERM: "dumb",
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: "sk-bench",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
  }
}

function message(call: { name: string; input: Record<string, unknown> } | { text: string }, id: string, model: string) {
  return {
    id: `msg_${id}`,
    type: "message",
    role: "assistant",
    model,
    content:
      "name" in call
        ? [{ type: "tool_use", id, name: call.name, input: call.input }]
        : [{ type: "text", text: call.text }],
    stop_reason: "name" in call ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }
}

// One streamed response in the Anthropic Messages SSE format.
function stream(call: { name: string; input: Record<string, unknown> } | { text: string }, id: string, model: string) {
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const start = { ...message(call, id, model), content: [], stop_reason: null }
  const block =
    "name" in call
      ? [
          event("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id, name: call.name, input: {} },
          }),
          event("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
          }),
        ]
      : [
          event("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
          event("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: call.text },
          }),
        ]
  return [
    event("message_start", { type: "message_start", message: start }),
    ...block,
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "name" in call ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    event("message_stop", { type: "message_stop" }),
  ].join("")
}

// Prices each request in order, keeping the set of prefixes Anthropic would have cached. Within a request the order
// is tools, then system, then messages, which is the order Anthropic's cache prefix follows.
function price(requests: Recorded[]): RequestCost[] {
  const cached = new Set<string>()
  const main = toolSignature(requests.find((item) => toolsOf(item).length > 0))
  return requests.map((request, index) => {
    const blocks = toBlocks(request.body)
    const prefixes = blocks.reduce<{ keys: string[]; tokens: number[] }>(
      (acc, block) => ({
        keys: [...acc.keys, `${acc.keys.at(-1) ?? ""}\u0000${block.key}`],
        tokens: [...acc.tokens, (acc.tokens.at(-1) ?? 0) + block.tokens],
      }),
      { keys: [], tokens: [] },
    )
    const breakpoints = blocks.flatMap((block, at) =>
      block.breakpoint && (prefixes.tokens[at] ?? 0) >= MIN_CACHEABLE_TOKENS ? [at] : [],
    )
    const inputTokens = prefixes.tokens.at(-1) ?? 0
    const last = breakpoints.at(-1)
    const hit = breakpoints
      .map((at) => {
        const from = Math.max(0, at - LOOKBACK_BLOCKS)
        return Array.from({ length: at - from + 1 }, (_, offset) => at - offset).find((k) =>
          cached.has(prefixes.keys[k] ?? ""),
        )
      })
      .reduce<number | undefined>((best, k) => (k === undefined ? best : Math.max(best ?? -1, k)), undefined)
    breakpoints.forEach((at) => cached.add(prefixes.keys[at] ?? ""))
    const cacheRead = hit === undefined ? 0 : (prefixes.tokens[hit] ?? 0)
    const cacheWrite = last === undefined ? 0 : (prefixes.tokens[last] ?? 0) - cacheRead
    const uncached = inputTokens - cacheRead - cacheWrite
    const outputTokens = estimate(request.output)
    const tools = toolsOf(request)
    const who = tools.length === 0 ? "side" : toolSignature(request) === main ? "agent" : "subagent"
    const toolTokens = tools.reduce<number>((total, tool) => total + estimate(strip(tool)), 0)
    const systemTokens = systemBlocks(request.body).reduce<number>((total, block) => total + estimate(strip(block)), 0)
    return {
      index: index + 1,
      who,
      tools: tools.length,
      systemTokens,
      toolTokens,
      messageTokens: inputTokens - toolTokens - systemTokens,
      inputTokens,
      cacheRead,
      cacheWrite,
      uncached,
      outputTokens,
      costUsd: dollars(
        uncached * PRICE.input +
          cacheWrite * PRICE.cacheWrite +
          cacheRead * PRICE.cacheRead +
          outputTokens * PRICE.output,
      ),
      uncachedCostUsd: dollars(inputTokens * PRICE.input + outputTokens * PRICE.output),
    }
  })
}

function toBlocks(body: Record<string, unknown>): Block[] {
  const block = (item: unknown) => {
    const key = strip(item)
    return { key, tokens: estimate(key), breakpoint: JSON.stringify(item).includes('"cache_control"') }
  }
  return [
    ...(Array.isArray(body.tools) ? body.tools : []).map(block),
    ...systemBlocks(body).map(block),
    ...(Array.isArray(body.messages) ? body.messages : []).map(block),
  ]
}

function systemBlocks(body: Record<string, unknown>): unknown[] {
  if (typeof body.system === "string") return [{ type: "text", text: body.system }]
  return Array.isArray(body.system) ? body.system : []
}

function toolsOf(request: Recorded | undefined) {
  return Array.isArray(request?.body.tools) ? (request.body.tools as Array<Record<string, unknown>>) : []
}

// The main agent and a subagent are told apart by the tools they are offered.
function toolSignature(request: Recorded | undefined) {
  return toolsOf(request)
    .map((tool) => String(tool.name))
    .toSorted()
    .join(",")
}

// The cache key of a block is its content; where its cache_control marker sits does not change it.
function strip(item: unknown) {
  return JSON.stringify(item, (name, value) => (name === "cache_control" ? undefined : value))
}

// Each tool definition's size, for the main agent's first request and a subagent's: the fixed cost every request pays.
function toolDefinitions(requests: Recorded[]) {
  const withTools = requests.filter((item) => toolsOf(item).length > 0)
  const main = toolSignature(withTools[0])
  const sizes = (request: Recorded | undefined) =>
    Object.fromEntries(
      toolsOf(request)
        .map((tool) => [String(tool.name), estimate(strip(tool))] as const)
        .toSorted((a, b) => b[1] - a[1]),
    )
  return { agent: sizes(withTools[0]), subagent: sizes(withTools.find((item) => toolSignature(item) !== main)) }
}

function renderDefinitions(definitions: ReturnType<typeof toolDefinitions>) {
  const line = (label: string, sizes: Record<string, number>) =>
    Object.keys(sizes).length === 0
      ? []
      : [
          `  ${label} tool definitions: ${Object.entries(sizes)
            .map(([name, tokens]) => `${name} ${tokens}`)
            .join(", ")}`,
        ]
  return [...line("Agent", definitions.agent), ...line("Subagent", definitions.subagent)].join("\n")
}

// About four characters per token, close enough to compare runtimes; the same estimate is used everywhere.
function estimate(text: string) {
  return Math.ceil(text.length / 4)
}

function dollars(tokenDollars: number) {
  return Math.round(tokenDollars) / 1_000_000
}

function totals(costs: RequestCost[]) {
  const sum = (pick: (cost: RequestCost) => number) => costs.reduce((total, cost) => total + pick(cost), 0)
  const input = sum((cost) => cost.inputTokens)
  const working = costs.filter((cost) => cost.who !== "side")
  return {
    requests: costs.length,
    subagentRequests: costs.filter((cost) => cost.who === "subagent").length,
    sideRequests: costs.filter((cost) => cost.who === "side").length,
    inputTokens: input,
    cacheRead: sum((cost) => cost.cacheRead),
    cacheWrite: sum((cost) => cost.cacheWrite),
    uncached: sum((cost) => cost.uncached),
    cacheReadShare: input === 0 ? 0 : Math.round((sum((cost) => cost.cacheRead) / input) * 1000) / 1000,
    fixedTokensPerRequest: Math.round(
      working.reduce((total, cost) => total + cost.systemTokens + cost.toolTokens, 0) / Math.max(1, working.length),
    ),
    costUsd: dollars(sum((cost) => cost.costUsd) * 1_000_000),
    uncachedCostUsd: dollars(sum((cost) => cost.uncachedCostUsd) * 1_000_000),
  }
}

function render(costs: RequestCost[]) {
  const rows = [
    ["#", "WHO", "TOOLS", "SYSTEM", "TOOL DEFS", "MESSAGES", "INPUT", "READ", "WRITE", "UNCACHED", "COST"],
    ...costs.map((cost) => [
      String(cost.index),
      cost.who,
      String(cost.tools),
      String(cost.systemTokens),
      String(cost.toolTokens),
      String(cost.messageTokens),
      String(cost.inputTokens),
      String(cost.cacheRead),
      String(cost.cacheWrite),
      String(cost.uncached),
      `$${cost.costUsd.toFixed(4)}`,
    ]),
  ]
  const sum = totals(costs)
  return [
    ...table(rows).map((line) => `  ${line}`),
    `  ${sum.requests} requests (${sum.subagentRequests} subagent, ${sum.sideRequests} side) · ${sum.inputTokens} input tokens, ${Math.round(sum.cacheReadShare * 100)}% read from cache · ${sum.fixedTokensPerRequest} fixed tokens per request (system + tool definitions)`,
    `  $${sum.costUsd.toFixed(4)} with prompt caching, $${sum.uncachedCostUsd.toFixed(4)} without · tokens ≈ characters / 4`,
  ].join("\n")
}

function renderComparison(reports: Array<Record<string, unknown>>) {
  const rows = [
    ["SCENARIO", "RUNTIME", "REQUESTS", "INPUT TOKENS", "CACHED", "FIXED/REQ", "COST", "NO CACHE"],
    ...reports.map((report) => {
      const sum = report.totals as ReturnType<typeof totals> | undefined
      if (!sum) return [String(report.scenario), String(report.runtime), report.unavailable ? "unavailable" : "failed"]
      return [
        String(report.scenario),
        String(report.runtime),
        String(sum.requests),
        String(sum.inputTokens),
        `${Math.round(sum.cacheReadShare * 100)}%`,
        String(sum.fixedTokensPerRequest),
        `$${sum.costUsd.toFixed(4)}`,
        `$${sum.uncachedCostUsd.toFixed(4)}`,
      ]
    }),
  ]
  return table(rows)
    .map((line) => `  ${line}`)
    .join("\n")
}

function table(rows: string[][]) {
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)))
  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd(),
  )
}

// `clean` starts the process with only the given environment, nothing inherited.
function exec(command: string, args: string[], cwd: string, env: Record<string, string> = {}, clean = false) {
  return new Promise<{ exitCode: number; output: string }>((done) => {
    const child = spawn(command, args, {
      cwd,
      env: clean ? env : { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const output: string[] = []
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")))
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000)
    child.once("close", (code) => {
      clearTimeout(timer)
      done({ exitCode: code ?? 1, output: output.join("") })
    })
  })
}

function parseFlags(argv: string[]) {
  const value = (name: string) => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? undefined : argv[at + 1]
  }
  return { scenario: value("scenario"), runtime: value("runtime"), out: value("out"), keep: argv.includes("--keep") }
}
