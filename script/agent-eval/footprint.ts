#!/usr/bin/env bun
// Offline request-cost benchmark. Runs the real `vector run` against a local fake model server that plays a fixed
// script of tool calls, records every request the engine sends, and prices each one under Anthropic's prompt-caching
// rules. No API key, no network and no model variance: the same build always produces the same numbers, so two
// builds can be compared exactly. It measures what Vector sends, not how well a model would do with it; the live
// harness in run.ts measures that.
//
//   bun script/agent-eval/footprint.ts                 every scenario
//   bun script/agent-eval/footprint.ts --scenario solo-fix
//   bun script/agent-eval/footprint.ts --out report.json

import { spawn } from "node:child_process"
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

type Turn = { tool: string; input: Record<string, unknown> } | { text: string }

type Scenario = {
  id: string
  title: string
  task: string
  turns: (dir: string) => Turn[]
}

const SCENARIOS: Scenario[] = [
  {
    id: "solo-fix",
    title: "Fix a failing test alone: run the suite, read, edit, re-run, answer",
    task: "bugfix-overdue-invoices",
    turns: (dir) => [
      { tool: "bash", input: { command: "bun test", description: "Run the test suite" } },
      { tool: "read", input: { filePath: join(dir, "src/invoice.ts") } },
      {
        tool: "edit",
        input: {
          filePath: join(dir, "src/invoice.ts"),
          oldString: "invoice.dueOn <= today",
          newString: "invoice.dueOn < today",
        },
      },
      { tool: "bash", input: { command: "bun test", description: "Run the test suite again" } },
      { text: "Fixed: an invoice due today is no longer counted as overdue. The whole suite passes." },
    ],
  },
  {
    id: "delegate-explore",
    title: "Hand the search to an explore subagent, then fix and verify",
    task: "bugfix-overdue-invoices",
    turns: (dir) => [
      {
        tool: "task",
        input: {
          description: "find the failing boundary",
          prompt: "Find why `bun test` fails in this repository. Report the file, the line and the cause.",
          subagent_type: "explore",
        },
      },
      // The explore subagent's own steps.
      { tool: "grep", input: { pattern: "dueOn", path: dir } },
      { tool: "read", input: { filePath: join(dir, "src/invoice.ts") } },
      { text: "src/invoice.ts line 5: `invoice.dueOn <= today` counts an invoice due today as overdue; use `<`." },
      // Back in the parent.
      { tool: "read", input: { filePath: join(dir, "src/invoice.ts") } },
      {
        tool: "edit",
        input: {
          filePath: join(dir, "src/invoice.ts"),
          oldString: "invoice.dueOn <= today",
          newString: "invoice.dueOn < today",
        },
      },
      { tool: "bash", input: { command: "bun test", description: "Run the test suite" } },
      { text: "Fixed the boundary in src/invoice.ts; the suite passes." },
    ],
  },
  {
    id: "delegate-general",
    title: "Hand the whole fix to a general subagent, then check its work",
    task: "bugfix-overdue-invoices",
    turns: (dir) => [
      {
        tool: "task",
        input: {
          description: "fix the failing boundary",
          prompt: "Make `bun test` pass in this repository without editing test/. Report the change and the test run.",
          subagent_type: "general",
        },
      },
      // The general subagent's own steps.
      { tool: "bash", input: { command: "bun test", description: "Run the test suite" } },
      { tool: "read", input: { filePath: join(dir, "src/invoice.ts") } },
      {
        tool: "edit",
        input: {
          filePath: join(dir, "src/invoice.ts"),
          oldString: "invoice.dueOn <= today",
          newString: "invoice.dueOn < today",
        },
      },
      { tool: "bash", input: { command: "bun test", description: "Run the test suite again" } },
      { text: "Changed `<=` to `<` in src/invoice.ts line 5; `bun test` passes (3 tests)." },
      // Back in the parent.
      { tool: "bash", input: { command: "bun test", description: "Verify the subagent's fix" } },
      { text: "Fixed the boundary in src/invoice.ts; the suite passes." },
    ],
  },
  {
    id: "long-loop",
    title: "A 12-step investigation: how the prompt cache holds up as a tool loop grows",
    task: "discipline-single-file-fix",
    turns: (dir) => [
      { tool: "bash", input: { command: "bun test", description: "Run the test suite" } },
      { tool: "glob", input: { pattern: "**/*.ts" } },
      { tool: "read", input: { filePath: join(dir, "README.md") } },
      { tool: "grep", input: { pattern: "export function", path: dir } },
      { tool: "read", input: { filePath: join(dir, "src/args.ts") } },
      { tool: "read", input: { filePath: join(dir, "src/logger.ts") } },
      { tool: "read", input: { filePath: join(dir, "src/config.ts") } },
      { tool: "grep", input: { pattern: "TODO", path: dir } },
      { tool: "bash", input: { command: "git status --short", description: "Check the working tree" } },
      { tool: "bash", input: { command: "bun test", description: "Run the test suite again" } },
      { tool: "glob", input: { pattern: "test/**/*.ts" } },
      { text: "Investigation finished; the failing case is in src/args.ts." },
    ],
  },
]

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
const selected = flags.scenario ? SCENARIOS.filter((scenario) => scenario.id === flags.scenario) : SCENARIOS
if (selected.length === 0) {
  process.stderr.write(
    `Unknown scenario ${flags.scenario}. Scenarios: ${SCENARIOS.map((item) => item.id).join(", ")}\n`,
  )
  process.exit(2)
}

const reports = []
for (const scenario of selected) {
  process.stderr.write(`\n=== ${scenario.id}: ${scenario.title} ===\n`)
  const recorded = await runScenario(scenario)
  if ("error" in recorded) {
    process.stderr.write(`  failed: ${recorded.error}\n`)
    reports.push({ scenario: scenario.id, error: recorded.error })
    continue
  }
  const costs = price(recorded.requests)
  const definitions = toolDefinitions(recorded.requests)
  process.stdout.write(`\n${scenario.id} — ${scenario.title}\n${render(costs)}\n${renderDefinitions(definitions)}\n`)
  reports.push({
    scenario: scenario.id,
    exitCode: recorded.exitCode,
    requests: costs,
    totals: totals(costs),
    toolDefinitions: definitions,
  })
}

const out = flags.out ?? join(tmpdir(), `vector-footprint-${Date.now()}.json`)
await writeFile(out, JSON.stringify({ model: MODEL, price: PRICE, scenarios: reports }, null, 2) + "\n")
process.stdout.write(`\nJSON report: ${out}\n`)

async function runScenario(scenario: Scenario) {
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
  await exec("git", ["-c", "init.defaultBranch=bench", "init", "--quiet"], dir)
  await exec("git", ["-c", "user.name=Bench", "-c", "user.email=bench@vector.local", "add", "-A"], dir)
  await exec(
    "git",
    ["-c", "user.name=Bench", "-c", "user.email=bench@vector.local", "commit", "--quiet", "-m", "baseline"],
    dir,
  )

  const turns = scenario.turns(dir)
  const requests: Recorded[] = []
  let call = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>
      const tools = Array.isArray(body.tools) ? body.tools : []
      // Requests without tools are side calls such as title generation; they do not advance the script.
      const turn: Turn = tools.length === 0 ? { text: "Bench task" } : (turns.shift() ?? { text: "Done." })
      const output = "tool" in turn ? JSON.stringify(turn.input) : turn.text
      requests.push({ body, output })
      return new Response(stream(turn, `call_${++call}`), { headers: { "content-type": "text/event-stream" } })
    },
  })

  const config = {
    formatter: false,
    lsp: false,
    provider: {
      bench: {
        name: "Bench",
        id: "bench",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          [MODEL]: {
            id: MODEL,
            name: "Claude Sonnet 4.5 (bench)",
            attachment: false,
            reasoning: false,
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
        options: { apiKey: "bench", baseURL: `http://127.0.0.1:${server.port}/v1` },
      },
    },
  }
  const result = await exec(
    "bun",
    [
      "run",
      "--conditions=browser",
      ENGINE,
      "run",
      "--format",
      "json",
      "--model",
      `bench/${MODEL}`,
      "--dangerously-skip-permissions",
      task.prompt,
    ],
    dir,
    {
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
    },
  )
  server.stop(true)
  if (!flags.keep) await rm(root, { recursive: true, force: true })
  if (requests.length === 0)
    return { error: `the engine sent no requests (exit ${result.exitCode}): ${result.output.slice(-600)}` }
  if (turns.length > 0) process.stderr.write(`  note: ${turns.length} scripted turn(s) were never requested\n`)
  return { exitCode: result.exitCode, requests }
}

// One SSE response in the OpenAI chat-completions format, with usage so the engine records something.
function stream(turn: Turn, id: string) {
  const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const base = { id: `chatcmpl-${id}`, object: "chat.completion.chunk", created: 0, model: MODEL }
  const delta =
    "tool" in turn
      ? {
          role: "assistant",
          tool_calls: [
            { index: 0, id, type: "function", function: { name: turn.tool, arguments: JSON.stringify(turn.input) } },
          ],
        }
      : { role: "assistant", content: turn.text }
  return [
    chunk({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }),
    chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool" in turn ? "tool_calls" : "stop" }] }),
    chunk({ ...base, choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }),
    "data: [DONE]\n\n",
  ].join("")
}

// Prices each request in order, keeping the set of prefixes Anthropic would have cached. Within a request the order
// is tools, then system, then messages, which is the order Anthropic's cache prefix follows.
function price(requests: Recorded[]): RequestCost[] {
  const cached = new Set<string>()
  const firstSystem = systemText(
    requests.find((item) => Array.isArray(item.body.tools) && item.body.tools.length > 0)?.body,
  )
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
    const tools = Array.isArray(request.body.tools) ? request.body.tools : []
    const system = systemText(request.body)
    const who = tools.length === 0 ? "side" : system === firstSystem ? "agent" : "subagent"
    const toolTokens = tools.reduce<number>((total, tool) => total + estimate(JSON.stringify(tool)), 0)
    const systemTokens = estimate(system)
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

// Each tool definition's size, for the main agent's first request and a subagent's: the fixed cost every request pays.
function toolDefinitions(requests: Recorded[]) {
  const withTools = requests.filter((item) => Array.isArray(item.body.tools) && item.body.tools.length > 0)
  const first = systemText(withTools[0]?.body)
  const sizes = (request: Recorded | undefined) =>
    Object.fromEntries(
      (Array.isArray(request?.body.tools) ? request.body.tools : [])
        .map((tool) => {
          const name = (tool as { function?: { name?: string } }).function?.name ?? "?"
          return [name, estimate(JSON.stringify(tool))] as const
        })
        .toSorted((a, b) => b[1] - a[1]),
    )
  return {
    agent: sizes(withTools[0]),
    subagent: sizes(withTools.find((item) => systemText(item.body) !== first)),
  }
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

function toBlocks(body: Record<string, unknown>): Block[] {
  const tools = (Array.isArray(body.tools) ? body.tools : []).map((tool) => ({
    key: JSON.stringify(tool),
    tokens: estimate(JSON.stringify(tool)),
    breakpoint: false,
  }))
  const messages = (Array.isArray(body.messages) ? body.messages : []).map((message) => {
    const marked = JSON.stringify(message).includes('"cache_control"')
    const key = JSON.stringify(message, (name, value) => (name === "cache_control" ? undefined : value))
    return { key, tokens: estimate(key), breakpoint: marked }
  })
  return [...tools, ...messages]
}

function systemText(body: Record<string, unknown> | undefined) {
  const messages = Array.isArray(body?.messages) ? (body.messages as Array<Record<string, unknown>>) : []
  return messages
    .filter((message) => message.role === "system")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (Array.isArray(message.content) ? message.content : [])
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .join(""),
    )
    .join("\n")
}

// About four characters per token, close enough to compare two builds; the same estimate is used everywhere.
function estimate(text: string) {
  return Math.ceil(text.length / 4)
}

function dollars(tokenDollars: number) {
  return Math.round((tokenDollars / 1_000_000) * 1_000_000) / 1_000_000
}

function totals(costs: RequestCost[]) {
  const sum = (pick: (cost: RequestCost) => number) => costs.reduce((total, cost) => total + pick(cost), 0)
  const input = sum((cost) => cost.inputTokens)
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
      sum((cost) => cost.systemTokens + cost.toolTokens) /
        Math.max(1, costs.filter((cost) => cost.who !== "side").length),
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
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)))
  const table = rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd(),
  )
  const sum = totals(costs)
  return [
    ...table.map((line) => `  ${line}`),
    `  ${sum.requests} requests (${sum.subagentRequests} subagent, ${sum.sideRequests} side) · ${sum.inputTokens} input tokens, ${Math.round(sum.cacheReadShare * 100)}% read from cache · ${sum.fixedTokensPerRequest} fixed tokens per request (system + tool definitions)`,
    `  $${sum.costUsd.toFixed(4)} with prompt caching, $${sum.uncachedCostUsd.toFixed(4)} without · tokens ≈ characters / 4`,
  ].join("\n")
}

function exec(command: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  return new Promise<{ exitCode: number; output: string }>((done) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
    const output: string[] = []
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")))
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000)
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
  return { scenario: value("scenario"), out: value("out"), keep: argv.includes("--keep") }
}
