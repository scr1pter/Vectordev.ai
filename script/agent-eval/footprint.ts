#!/usr/bin/env bun
// Offline request-cost benchmark. Runs a real agent (Vector's `vector run`, the Claude Code CLI or the Codex CLI)
// against a local fake model server (Anthropic Messages, or OpenAI Responses for Codex) that plays a fixed script of
// tool calls, records every request the agent sends, and estimates request sizes and hypothetical cost. No paid API
// calls and no model variance. Timing and request envelopes still vary by machine and CLI release. It measures
// what each runtime sends, not how well a model would do with it; the live harness in run.ts measures that.
//
//   bun script/agent-eval/footprint.ts                              Vector, every scenario
//   bun script/agent-eval/footprint.ts --runtime vector,claude-code,codex side by side
//   bun script/agent-eval/footprint.ts --runtime codex --codex /path/to/codex
//   bun script/agent-eval/footprint.ts --scenario solo-fix --out report.json

import { spawn, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { taskById } from "./tasks"
import { codexCall, completedRun, responseStream, type Call } from "./footprint-protocol"

const REPO_ROOT = resolve(import.meta.dir, "../..")
const ENGINE = join(REPO_ROOT, "packages", "engine", "src", "index.ts")
const MODEL = "claude-sonnet-4-5"
// Claude Sonnet 4.5 list prices per million tokens; a 5-minute cache write costs 1.25x input, a read 0.1x.
const PRICE = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 }
// Anthropic caches nothing shorter than this, and looks back at most this many blocks from a breakpoint for a hit.
const MIN_CACHEABLE_TOKENS = 1_024
const LOOKBACK_BLOCKS = 20

type Runtime = "vector" | "claude-code" | "codex"
const RUNTIMES: Runtime[] = ["vector", "claude-code", "codex"]

// A runtime-neutral step. Each runtime gets it as a call to its own tool for the job, so both do the same work.
type Step =
  | { kind: "bash"; command: string; description: string }
  | { kind: "read"; path: string }
  | { kind: "edit"; path: string; from: string; to: string }
  | { kind: "search"; pattern: string }
  | { kind: "list"; pattern: string }
  | { kind: "delegate"; agent: "explore" | "general"; description: string; prompt: string }
  // sub marks the subagent's final report, which a runtime without subagents never writes.
  | { kind: "answer"; text: string; sub?: true }

type Scenario = { id: string; title: string; task: string; steps: Step[] }

// Whole lines, so the same edit also works as a patch hunk for Codex.
const FIX: Step = {
  kind: "edit",
  path: "src/invoice.ts",
  from: "  return invoices.filter((invoice) => !invoice.paidOn && invoice.dueOn <= today)",
  to: "  return invoices.filter((invoice) => !invoice.paidOn && invoice.dueOn < today)",
}
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
        sub: true,
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
      { kind: "answer", text: "Changed `<=` to `<` in src/invoice.ts line 5; `bun test` passes (3 tests).", sub: true },
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
      { kind: "read", path: "src/parse-args.ts" },
      { kind: "read", path: "src/logger.ts" },
      { kind: "read", path: "src/config.ts" },
      { kind: "search", pattern: "TODO" },
      {
        kind: "edit",
        path: "src/parse-args.ts",
        from: "    const next = argv[index + 1]",
        to: '    const separator = token.indexOf("=")\n    if (separator !== -1) {\n      flags[token.slice(2, separator)] = token.slice(separator + 1)\n      continue\n    }\n    const next = argv[index + 1]',
      },
      TEST,
      { kind: "list", pattern: "test/**/*.ts" },
      { kind: "answer", text: "Fixed --key=value handling in src/parse-args.ts; the suite passes." },
    ],
  },
]

// This harness currently flattens Codex delegation into parent steps. It does
// not exercise Codex's native delegation; these scenarios are explicitly
// different workflows and cannot establish a comparative winner.
function stepsFor(runtime: Runtime, scenario: Scenario) {
  if (runtime !== "codex") return scenario.steps
  return scenario.steps.filter((step) => step.kind !== "delegate" && !(step.kind === "answer" && step.sub))
}

// The call each runtime makes for a step, with its own tool names and parameters. Claude Code has no separate search
// or list tool, so those run through Bash with ripgrep, as it does them; Codex does everything but edits through its
// shell tool, and edits with an apply_patch hunk.
function toolCall(runtime: Runtime, step: Step, dir: string): Call {
  const path = (relative: string) => join(dir, relative)
  if (step.kind === "answer") return { text: step.text }
  if (runtime === "codex") {
    if (step.kind === "edit")
      return {
        name: "apply_patch",
        custom: `*** Begin Patch\n*** Update File: ${step.path}\n@@\n-${step.from}\n+${step.to}\n*** End Patch\n`,
      }
    const cmd =
      step.kind === "bash"
        ? step.command
        : step.kind === "read"
          ? `sed -n '1,250p' ${step.path}`
          : step.kind === "search"
            ? `rg -n ${JSON.stringify(step.pattern)}`
            : step.kind === "list"
              ? `rg --files -g ${JSON.stringify(step.pattern)}`
              : "true"
    return { name: "exec_command", input: { cmd } }
  }
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

type Recorded = { body: Record<string, unknown>; output: string; toolCall: boolean }

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
const CODEX = flags.codex ?? process.env.VECTOR_EVAL_CODEX ?? "codex"
const CODEX_MODEL = "gpt-5.5"
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
const repeat = Number(flags.repeat ?? 1)
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) {
  process.stderr.write("--repeat must be an integer between 1 and 20\n")
  process.exit(2)
}
if (!Number.isFinite(Number(flags.timeout ?? 240)) || Number(flags.timeout ?? 240) <= 0) {
  process.stderr.write("--timeout must be a positive number of seconds\n")
  process.exit(2)
}
const startedAt = new Date().toISOString()
const sourceBefore = await sourceProvenance()
for (const scenario of scenarios) {
  for (const attempt of Array.from({ length: repeat }, (_, index) => index + 1)) {
    // Alternate first mover to reduce warm-cache and process-order bias.
    const order = attempt % 2 === 1 ? runtimes : runtimes.toReversed()
    for (const [position, runtime] of (order as Runtime[]).entries()) {
      process.stderr.write(`\n=== ${runtime} · ${scenario.id}: ${scenario.title} ===\n`)
      const cli = runtime === "claude-code" ? "claude" : runtime === "codex" ? CODEX : undefined
      if (cli && spawnSync(cli, ["--version"]).status !== 0) {
        process.stderr.write(`  unavailable: the ${cli} CLI was not found\n`)
        reports.push({
          scenario: scenario.id,
          runtime,
          attempt,
          order: position + 1,
          unavailable: true,
          comparable: false,
        })
        continue
      }
      const recorded = await runScenario(scenario, runtime)
      if ("error" in recorded) {
        process.stderr.write(`  ${recorded.unavailable ? "unavailable" : "failed"}: ${recorded.error}\n`)
        reports.push({
          scenario: scenario.id,
          runtime,
          attempt,
          order: position + 1,
          error: recorded.error,
          unavailable: recorded.unavailable,
          comparable: false,
        })
        continue
      }
      const costs = price(recorded.requests)
      const definitions = toolDefinitions(recorded.requests)
      if (!recorded.complete)
        process.stderr.write("  invalid run: completion or objective validation failed; excluded from comparison\n")
      process.stdout.write(
        `\n${runtime} · ${scenario.id} — ${scenario.title}\n${render(costs)}\n${renderDefinitions(definitions)}\n`,
      )
      reports.push({
        scenario: scenario.id,
        runtime,
        attempt,
        order: position + 1,
        workflow: scenario.id.startsWith("delegate-") ? "different-delegation-workflow" : "paired-script",
        comparable: recorded.complete && !scenario.id.startsWith("delegate-"),
        complete: recorded.complete,
        exitCode: recorded.exitCode,
        unplayed: recorded.unplayed,
        elapsedMs: recorded.elapsedMs,
        validation: recorded.validation,
        diff: recorded.diff,
        diagnostics: recorded.diagnostics,
        protocolErrors: recorded.protocolErrors,
        scriptedToolCalls: stepsFor(runtime, scenario).filter((step) => step.kind !== "answer").length,
        toolCallsSent: recorded.requests.filter((request) => request.toolCall).length,
        wireInputBytes: recorded.requests.reduce(
          (total, request) => total + Buffer.byteLength(JSON.stringify(request.body), "utf8"),
          0,
        ),
        requests: costs,
        totals: totals(costs),
        toolDefinitions: definitions,
      })
    }
  }
}
if (runtimes.length > 1) process.stdout.write(`\nSide by side\n${renderComparison(reports)}\n`)

const out = flags.out ?? join(tmpdir(), `vector-footprint-${Date.now()}.json`)
const sourceAfter = await sourceProvenance()
await writeFile(
  out,
  JSON.stringify(
    {
      version: 2,
      mode: "offline-scripted-overhead",
      actualSpendUsd: 0,
      qualityMeasured: false,
      startedAt,
      completedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      bun: Bun.version,
      revision: sourceBefore.revision,
      source: {
        before: sourceBefore,
        after: sourceAfter,
        productionSourceStable: sourceBefore.production.workingSha256 === sourceAfter.production.workingSha256,
      },
      codex: runtimes.includes("codex")
        ? spawnSync(CODEX, ["--version"], { encoding: "utf8" }).stdout?.trim()
        : undefined,
      model: {
        vector: MODEL,
        codex: CODEX_MODEL,
        note: "Protocol labels only; no model ran. Identical scripted steps, different API envelopes.",
      },
      estimates: {
        tokenizer: "ceil(characters/4)",
        price: PRICE,
        note: "Hypothetical Sonnet rates; Anthropic explicit and Responses implicit cache simulations are different assumptions, not measured provider bills.",
      },
      repetitions: repeat,
      comparisons: scenarios.flatMap((scenario) =>
        Array.from({ length: repeat }, (_, index) => {
          const paired = reports.filter((report) => report.scenario === scenario.id && report.attempt === index + 1)
          return {
            scenario: scenario.id,
            attempt: index + 1,
            comparable:
              runtimes.length > 1 && paired.length === runtimes.length && paired.every((report) => report.comparable),
            reason: scenario.id.startsWith("delegate-")
              ? "different delegation workflows"
              : paired.some((report) => report.unavailable)
                ? "runtime unavailable"
                : paired.some((report) => !report.complete)
                  ? "invalid or unfinished run"
                  : runtimes.length < 2
                    ? "one runtime measured"
                    : "validated same scripted steps",
          }
        }),
      ),
      scenarios: reports,
    },
    null,
    2,
  ) + "\n",
)
process.stdout.write(`\nJSON report: ${out}\n`)
if (
  reports.some((report) => (report.error && !report.unavailable) || (report.complete === false && !report.unavailable))
)
  process.exitCode = 1

async function runScenario(scenario: Scenario, runtime: Runtime) {
  const task = taskById(scenario.task)
  if (!task) return { error: `unknown task ${scenario.task}`, unavailable: false }
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

  const calls = stepsFor(runtime, scenario).map((step) => toolCall(runtime, step, dir))
  const requests: Recorded[] = []
  const protocolErrors: string[] = []
  let id = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: estimate(JSON.stringify(body)) })
      const responses = url.pathname.endsWith("/responses")
      if (!url.pathname.endsWith("/messages") && !responses) return Response.json({ data: [] })
      const tools = Array.isArray(body.tools) ? body.tools : []
      // Requests without tools are side calls such as title generation; they do not advance the script.
      const planned: Call = tools.length === 0 ? { text: "Bench task" } : (calls[0] ?? { text: "Done." })
      const selected = responses ? Promise.resolve().then(() => codexCall(planned, tools)) : Promise.resolve(planned)
      const call = await selected.catch((error: Error) => {
        protocolErrors.push(error.message)
        return undefined
      })
      if (!call)
        return Response.json(
          { error: { message: protocolErrors.at(-1), type: "invalid_request_error" } },
          { status: 400 },
        )
      if (tools.length > 0) calls.shift()
      requests.push({
        body,
        toolCall: !("text" in call),
        output: "custom" in call ? call.custom : "input" in call ? JSON.stringify(call.input) : call.text,
      })
      if (responses)
        return new Response(responseStream(call, ++id, String(body.model ?? "")), {
          headers: { "content-type": "text/event-stream" },
        })
      if ("custom" in call) return Response.json({ error: "custom tools are a Responses API feature" }, { status: 400 })
      if (body.stream !== true) return Response.json(message(call, `toolu_${++id}`, String(body.model ?? MODEL)))
      return new Response(stream(call, `toolu_${++id}`, String(body.model ?? MODEL)), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  const start = performance.now()
  const result =
    runtime === "vector"
      ? await exec("bun", vectorArgs(task.prompt), dir, vectorEnv(home, base), true)
      : runtime === "claude-code"
        ? await exec("claude", claudeArgs(task.prompt), dir, claudeEnv(home, base), true)
        : await exec(CODEX, codexArgs(task.prompt, base, home), dir, codexEnv(), true)
  const elapsedMs = Math.round(performance.now() - start)
  server.stop(true)
  const check = await exec(task.check.command, task.check.args, dir, { PATH: process.env.PATH ?? "" }, true)
  const status = await exec("git", ["status", "--porcelain", "--untracked-files=all"], dir)
  const changedFiles = status.output
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
  const numstat = await exec("git", ["diff", "--numstat", "HEAD"], dir)
  const stats = numstat.output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
  // Compare protected bytes directly: deletion, staged edits and untracked
  // replacement files must not escape the objective check.
  const protectedChanged = (
    await Promise.all(
      task.protectedFiles.map(async (path) => ({
        path,
        same: await readFile(join(dir, path), "utf8").then(
          (content) => content === task.files[path],
          () => false,
        ),
      })),
    )
  )
    .filter((item) => !item.same)
    .map((item) => item.path)
  const unexpectedChanged = changedFiles.filter((path) => !task.expectedFiles.includes(path))
  const validation = {
    checkExitCode: check.exitCode,
    checkOutput: check.output.slice(-4000),
    protectedChanged,
    unexpectedChanged,
  }
  const diff = {
    changedFiles,
    files: changedFiles.length,
    additions: stats.reduce((total, row) => total + (Number(row[0]) || 0), 0),
    deletions: stats.reduce((total, row) => total + (Number(row[1]) || 0), 0),
  }
  const complete = completedRun({ ...result, unplayed: calls.length, protocolErrors, ...validation })
  if (flags.keep) await writeFile(join(root, "requests.json"), JSON.stringify(requests, null, 2))
  if (!flags.keep) await rm(root, { recursive: true, force: true })
  if (requests.length === 0)
    return {
      unavailable: runtime === "codex" && /failed to initialize.*Read-only file system/s.test(result.output),
      error: `the agent sent no requests (exit ${result.exitCode}): ${result.output.slice(-800)}`,
    }
  if (calls.length > 0) process.stderr.write(`  note: ${calls.length} scripted step(s) were never requested\n`)
  return {
    exitCode: result.exitCode,
    requests,
    unplayed: calls.length,
    complete,
    elapsedMs,
    validation,
    diff,
    diagnostics: result.output.slice(-4000),
    protocolErrors,
  }
}

async function sourceProvenance() {
  const path = "packages/core/src/tool-output-store.ts"
  const revision = await exec("git", ["rev-parse", "HEAD"], REPO_ROOT)
  const status = await exec("git", ["status", "--porcelain", "--untracked-files=all"], REPO_ROOT)
  const head = await exec("git", ["show", `HEAD:${path}`], REPO_ROOT)
  return {
    revision: revision.output.trim(),
    dirty: status.output.length > 0,
    status: status.output.trimEnd().split("\n").filter(Boolean),
    production: {
      path,
      workingSha256: new Bun.CryptoHasher("sha256").update(await readFile(join(REPO_ROOT, path))).digest("hex"),
      headSha256: head.exitCode === 0 ? new Bun.CryptoHasher("sha256").update(head.output).digest("hex") : undefined,
    },
  }
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
    PATH: process.env.PATH ?? "",
    TERM: "dumb",
    VECTOR_TEST_HOME: home,
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
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    TERM: "dumb",
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: "sk-bench",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
  }
}

function codexArgs(prompt: string, base: string, home: string) {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    `model="${CODEX_MODEL}"`,
    "-c",
    'model_provider="bench"',
    "-c",
    'model_providers.bench.name="bench"',
    "-c",
    `model_providers.bench.base_url="${base}/v1"`,
    "-c",
    'model_providers.bench.env_key="BENCH_API_KEY"',
    "-c",
    'model_providers.bench.wire_api="responses"',
    "-c",
    "model_providers.bench.requires_openai_auth=false",
    "-c",
    "model_providers.bench.request_max_retries=0",
    "-c",
    "model_providers.bench.stream_max_retries=0",
    "-c",
    'web_search="disabled"',
    "-c",
    "analytics.enabled=false",
    "-c",
    "feedback.enabled=false",
    "-c",
    `sqlite_home=${JSON.stringify(join(home, "codex-state"))}`,
    "-c",
    `log_dir=${JSON.stringify(join(home, "codex-logs"))}`,
    prompt,
  ]
}

// Explicit provider config and an isolated environment prevent real credentials
// from entering this run, without repurposing HOME or CODEX_HOME.
function codexEnv() {
  return {
    PATH: process.env.PATH ?? "",
    TERM: "dumb",
    BENCH_API_KEY: "offline-placeholder",
    ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
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

// Prices each request in order, keeping the set of prefixes the provider would have cached. Within a request the
// order is tools, then system, then messages, which is the order the cache prefix follows. Anthropic caches only up to
// the breakpoints a request marks and charges extra to write them; the OpenAI Responses API (Codex) caches every
// prefix it has seen on its own and charges nothing to write, so there the longest prefix seen before is read.
function price(requests: Recorded[]): RequestCost[] {
  const cached = new Set<string>()
  const implicit = requests.some((request) => "input" in request.body && !("messages" in request.body))
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
    if (implicit) {
      const seen = prefixes.keys.findLastIndex(
        (key, at) => cached.has(key) && (prefixes.tokens[at] ?? 0) >= MIN_CACHEABLE_TOKENS,
      )
      prefixes.keys.forEach((key) => cached.add(key))
      const read = seen === -1 ? 0 : (prefixes.tokens[seen] ?? 0)
      return cost(request, index, { inputTokens, cacheRead: read, cacheWrite: 0 })
    }
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
    return cost(request, index, { inputTokens, cacheRead, cacheWrite })
  })

  function cost(
    request: Recorded,
    index: number,
    input: { inputTokens: number; cacheRead: number; cacheWrite: number },
  ): RequestCost {
    const { inputTokens, cacheRead, cacheWrite } = input
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
  }
}

function toBlocks(body: Record<string, unknown>): Block[] {
  const block = (item: unknown) => {
    const key = strip(item)
    return { key, tokens: estimate(key), breakpoint: JSON.stringify(item).includes('"cache_control"') }
  }
  return [
    ...(Array.isArray(body.tools) ? body.tools : []).map(block),
    ...systemBlocks(body).map(block),
    ...(Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []).map(block),
  ]
}

function systemBlocks(body: Record<string, unknown>): unknown[] {
  if (typeof body.instructions === "string") return [{ type: "text", text: body.instructions }]
  if (typeof body.system === "string") return [{ type: "text", text: body.system }]
  return Array.isArray(body.system) ? body.system : []
}

function toolsOf(request: Recorded | undefined) {
  return Array.isArray(request?.body.tools) ? (request.body.tools as Array<Record<string, unknown>>) : []
}

// The main agent and a subagent are told apart by the tools they are offered.
function toolSignature(request: Recorded | undefined) {
  return toolsOf(request)
    .map((tool) => String(tool.name ?? tool.type))
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
        .map((tool) => [String(tool.name ?? tool.type), estimate(strip(tool))] as const)
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
    ["SCENARIO", "RUNTIME", "RUN", "STATUS", "MS", "FILES", "+/-", "REQUESTS", "EST INPUT", "EST COST"],
    ...reports.map((report) => {
      const sum = report.totals as ReturnType<typeof totals> | undefined
      if (!sum)
        return [
          String(report.scenario),
          String(report.runtime),
          String(report.attempt),
          report.unavailable ? "unavailable" : "failed",
        ]
      return [
        String(report.scenario),
        String(report.runtime),
        String(report.attempt),
        !report.complete ? "invalid" : !report.comparable ? "different workflow" : "complete",
        String(report.elapsedMs),
        String((report.diff as { files: number }).files),
        `${(report.diff as { additions: number }).additions}/${(report.diff as { deletions: number }).deletions}`,
        String(sum.requests),
        String(sum.inputTokens),
        `$${sum.costUsd.toFixed(4)}`,
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
  return new Promise<{ exitCode: number; output: string; timedOut: boolean }>((done) => {
    const child = spawn(command, args, {
      cwd,
      env: clean ? env : { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const output: string[] = []
    const state = { timedOut: false }
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")))
    child.once("error", (error) => output.push(error.message))
    const timer = setTimeout(
      () => {
        state.timedOut = true
        child.kill("SIGKILL")
      },
      Number(flags.timeout ?? 240) * 1000,
    )
    child.once("close", (code) => {
      clearTimeout(timer)
      done({ exitCode: code ?? 1, output: output.join(""), timedOut: state.timedOut })
    })
  })
}

function parseFlags(argv: string[]) {
  const value = (name: string) => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? undefined : argv[at + 1]
  }
  return {
    scenario: value("scenario"),
    runtime: value("runtime"),
    codex: value("codex"),
    out: value("out"),
    keep: argv.includes("--keep"),
    repeat: value("repeat"),
    timeout: value("timeout"),
  }
}
