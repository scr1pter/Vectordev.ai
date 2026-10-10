#!/usr/bin/env bun
import { join, relative, resolve } from "node:path"
import { isIgnoredPath, matchesExpected } from "./score"
import { totalTokens, type Tokens } from "./meter"
import { TASKS } from "./tasks"

type Run = {
  runtime: string; taskId: string; attempt: number; artifact: string; normalCompletion: boolean;
  run: { status: string; diff?: { path: string; added: number; removed: number }[] };
  score: { outcome: string; score: number; filesTouched: number; linesTouched: number; outOfScopeFiles: string[]; protectedViolations: string[] };
  agent: { wallMs: number; timedOut: boolean; exitCode: number; meter: { tokens?: Tokens; requests?: number }; toolEventCount: number; toolEvents: Record<string, unknown>[]; sampledPeakProcessTreeRssKiB?: number; memorySamples: number; reportedErrors: unknown[] };
}
type Report = { startedAt: string; completedAt: string | null; status: string; repetitions: number; tasks: string[]; root: string; metadata: Record<string, unknown>; results: Run[] }
const ROOT = import.meta.dir
const RATES = { input: 2, cacheRead: 0.10, cacheWrite: 2.50, output: 10 }
const PRICE_URL = "https://developers.openai.com/api/docs/pricing"
const source = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, "runs/same-model-v2/report.json")
const report = await Bun.file(source).json() as Report
const validationPath = join(ROOT, "validation.json")
const validation = await Bun.file(validationPath).exists() ? await Bun.file(validationPath).json() as unknown : undefined
const modelEvidencePath = join(ROOT, "model-evidence.json")
const modelEvidence = await Bun.file(modelEvidencePath).exists() ? await Bun.file(modelEvidencePath).json() as unknown : undefined
const sourceIntegrityPath = join(ROOT, "source-integrity.json")
const sourceIntegrity = await Bun.file(sourceIntegrityPath).exists() ? await Bun.file(sourceIntegrityPath).json() as unknown : undefined
const authContextPath = join(ROOT, "auth-context.json")
const authContext = await Bun.file(authContextPath).exists() ? await Bun.file(authContextPath).json() as unknown : undefined
const escape = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
const link = (path: string, label: string) => `<a href="${escape(relative(ROOT, path))}">${escape(label)}</a>`
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function stats(values: (number | undefined | null)[]) {
  const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b)
  if (!known.length) return { count: 0, total: null, median: null, min: null, max: null }
  const mid = Math.floor(known.length / 2)
  return { count: known.length, total: known.reduce((sum, value) => sum + value, 0), median: known.length % 2 ? known[mid]! : (known[mid - 1]! + known[mid]!) / 2, min: known[0]!, max: known.at(-1)! }
}

function toolsFor(run: Run) {
  const exact: Record<string, number> = {}
  const categories: Record<string, number> = {}
  run.agent.toolEvents.forEach((event) => {
    const part = record(event.part)
    const item = record(event.item)
    const name = String(part?.tool ?? item?.type ?? event.type)
    exact[name] = (exact[name] ?? 0) + 1
    const category = ["bash", "shell", "command_execution"].includes(name) ? "shell" : ["glob", "grep", "read", "search"].includes(name) ? "read/search" : ["apply_patch", "edit", "write", "file_change"].includes(name) ? "edit" : ["todowrite", "todoread", "update_plan"].includes(name) ? "planning" : ["task", "collab_tool_call"].includes(name) ? "delegation" : name
    categories[category] = (categories[category] ?? 0) + 1
  })
  return { eventCount: run.agent.toolEventCount, exact, categories }
}

const rows = report.results.map((run) => {
  const task = TASKS.find((task) => task.id === run.taskId)
  const diffs = (run.run.diff ?? []).filter((file) => !isIgnoredPath(file.path))
  const sourceDiffs = diffs.filter((file) => matchesExpected(file.path, task?.expectedFiles ?? []))
  const tokens = run.agent.meter.tokens
  const price = tokens ? (tokens.input * RATES.input + tokens.cacheRead * RATES.cacheRead + tokens.cacheWrite * RATES.cacheWrite + tokens.output * RATES.output) / 1_000_000 : null
  return {
    runtime: run.runtime, taskId: run.taskId, attempt: run.attempt, outcome: run.score.outcome, score: run.score.score,
    normalCompletion: run.normalCompletion, timedOut: run.agent.timedOut, exitCode: run.agent.exitCode, reportedErrors: run.agent.reportedErrors.length,
    wallSeconds: run.agent.wallMs / 1000, tokens: tokens ?? null, totalTokens: tokens ? totalTokens(tokens) : null,
    apiEquivalentUsd: price, actualBilledUsd: null,
    sampledPeakProcessTreeMiB: run.agent.sampledPeakProcessTreeRssKiB == null ? null : run.agent.sampledPeakProcessTreeRssKiB / 1024,
    memorySamples: run.agent.memorySamples, providerRequests: run.agent.meter.requests ?? null,
    tools: toolsFor(run),
    sourceFilesTouched: sourceDiffs.length, sourceAdded: sourceDiffs.reduce((sum, file) => sum + file.added, 0), sourceDeleted: sourceDiffs.reduce((sum, file) => sum + file.removed, 0),
    allFilesTouched: run.score.filesTouched, allLinesTouched: run.score.linesTouched, outOfScopeFiles: run.score.outOfScopeFiles, protectedViolations: run.score.protectedViolations,
    artifacts: { result: relative(ROOT, join(run.artifact, "result.json")), patch: relative(ROOT, join(run.artifact, "final.patch")), stdout: relative(ROOT, join(run.artifact, "agent.stdout.log")), stderr: relative(ROOT, join(run.artifact, "agent.stderr.log")), checks: relative(ROOT, join(run.artifact, "final-check.stderr.log")) },
  }
})

function summarize(selected: typeof rows) {
  const categories: Record<string, number> = {}
  const exact: Record<string, number> = {}
  selected.forEach((row) => {
    Object.entries(row.tools.categories).forEach(([key, count]) => { categories[key] = (categories[key] ?? 0) + count })
    Object.entries(row.tools.exact).forEach(([key, count]) => { exact[key] = (exact[key] ?? 0) + count })
  })
  return {
    runs: selected.length, passed: selected.filter((row) => row.outcome === "pass").length, failed: selected.filter((row) => row.outcome === "fail").length,
    unavailable: selected.filter((row) => row.outcome === "unavailable").length, normalCompletions: selected.filter((row) => row.normalCompletion).length, timeouts: selected.filter((row) => row.timedOut).length,
    wallSeconds: stats(selected.map((row) => row.wallSeconds)), score: stats(selected.map((row) => row.score)), totalTokens: stats(selected.map((row) => row.totalTokens)),
    tokens: Object.fromEntries((["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const).map((key) => [key, stats(selected.map((row) => row.tokens?.[key]))])),
    apiEquivalentUsd: stats(selected.map((row) => row.apiEquivalentUsd)), actualBilledUsd: null,
    sampledPeakProcessTreeMiB: stats(selected.map((row) => row.sampledPeakProcessTreeMiB)),
    sourceFilesTouched: stats(selected.map((row) => row.sourceFilesTouched)), sourceAdded: stats(selected.map((row) => row.sourceAdded)), sourceDeleted: stats(selected.map((row) => row.sourceDeleted)), allLinesTouched: stats(selected.map((row) => row.allLinesTouched)),
    outOfScopeFileEdits: selected.reduce((sum, row) => sum + row.outOfScopeFiles.length, 0), protectedFileViolations: selected.reduce((sum, row) => sum + row.protectedViolations.length, 0),
    toolEvents: selected.reduce((sum, row) => sum + row.tools.eventCount, 0), toolCategories: categories, toolNames: exact,
  }
}

const expectedRuns = report.repetitions * report.tasks.length * 2
const byRuntime = Object.fromEntries(["vector", "codex"].map((runtime) => [runtime, summarize(rows.filter((row) => row.runtime === runtime))]))
const byTask = report.tasks.map((taskId) => ({ taskId, runtimes: Object.fromEntries(["vector", "codex"].map((runtime) => [runtime, summarize(rows.filter((row) => row.runtime === runtime && row.taskId === taskId))])) }))
const complete = report.status === "complete" && rows.length === expectedRuns
const summary = {
  title: "Vector and Codex local benchmark", generatedAt: new Date().toISOString(), state: complete ? "complete" : "partial", includedReport: relative(ROOT, source),
  observedRuns: rows.length, expectedRuns, startedAt: report.startedAt, completedAt: report.completedAt,
  metadata: report.metadata, repetitions: report.repetitions, tasks: report.tasks,
  pricing: { model: "gpt-6.1-sol", ratesUsdPerMillionTokens: RATES, source: PRICE_URL, verifiedDate: "2026-10-07", contextTier: "standard short context", meaning: "API-equivalent estimate from reported tokens; actual billed cost on ChatGPT sign-ins is unknown", reasoning: "Reasoning tokens are part of output, not added again" },
  methodology: ["Identical pristine fixtures and prompts; alternating runtime order; independent protected tests and content assertions", "GPT-6.1 Sol pinned in both launchers, medium reasoning; no implicit retry", "Vector source from pristine origin/main d3ae064a2; Codex installed CLI 0.162.0-alpha.2", "Project document loading disabled for both; isolated Vector provider configuration", "Both runtimes use ChatGPT OAuth for the same account; account identities and credentials are redacted from evidence", "PWD forced to fixture and Vector --dir explicit after detecting a launch-directory bug", "JSON stdout/stderr parsing buffers partial lines; Codex cache-write input is included as a separate token class", "Only runs/same-model-v2 is counted; aborted earlier run and authentication preflights excluded"],
  limitations: ["Three small synthetic tasks and three attempts each do not establish general agent superiority or statistical significance", "Wall time includes runtime startup and agent work; independent evaluator checks excluded", "Vector runs from Bun source while Codex is an installed CLI; build packaging/startup costs differ", "RSS sums recursively tracked process-tree resident memory every 500ms; shared pages can count twice and very short-lived descendants may be missed", "Tool events use different runtime schemas, so counts describe execution shape rather than directly comparable model turns", "Small code diffs measure edit scope; correctness and review remain necessary to assess maintainability", "Provider load, caching across attempts, and server-side model changes are not fully controlled", "Actual subscription billing is unknown; estimated API-equivalent cost is not an invoice"],
  byRuntime, byTask, runs: rows, independentValidation: validation ?? null, modelEvidence: modelEvidence ?? null, sourceIntegrity: sourceIntegrity ?? null, authContext: authContext ?? null,
}
await Bun.write(join(ROOT, "summary.json"), JSON.stringify(summary, null, 2) + "\n")

const num = (value: number | null | undefined, digits = 1) => value === null || value === undefined ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })
const integer = (value: number | null | undefined) => num(value, 0)
const medianRange = (value: ReturnType<typeof stats>, digits = 1) => value.count ? `${num(value.median, digits)} <small>(${num(value.min, digits)}–${num(value.max, digits)})</small>` : "—"
const title = (runtime: string) => runtime === "vector" ? "Vector" : "Codex"
const taskTitle = (taskId: string) => ({ "bugfix-idempotent-webhooks": "Duplicate / reordered webhooks", "feature-retry-schedule": "Retry schedule feature", "refactor-structured-logging": "12-module logging refactor" })[taskId] ?? taskId
const runtimeRows = Object.entries(byRuntime).map(([runtime, data]) => `<tr><th>${title(runtime)}</th><td>${data.passed}/${data.runs}</td><td>${data.normalCompletions}/${data.runs}</td><td>${num(data.wallSeconds.total)} s</td><td>${medianRange(data.wallSeconds)} s</td><td>${integer(data.totalTokens.total)}</td><td>$${num(data.apiEquivalentUsd.total, 4)}</td><td>${medianRange(data.sampledPeakProcessTreeMiB)} MiB</td><td>${data.toolEvents}</td></tr>`).join("")
const taskRows = byTask.flatMap((task) => Object.entries(task.runtimes).map(([runtime, data]) => `<tr><th>${escape(taskTitle(task.taskId))}</th><td>${title(runtime)}</td><td>${data.passed}/${data.runs}</td><td>${medianRange(data.wallSeconds)} s</td><td>${medianRange(data.totalTokens, 0)}</td><td>$${medianRange(data.apiEquivalentUsd, 4)}</td><td>${medianRange(data.sourceFilesTouched, 0)}</td><td>+${medianRange(data.sourceAdded, 0)} / −${medianRange(data.sourceDeleted, 0)}</td></tr>`)).join("")
const tokenRows = Object.entries(byRuntime).map(([runtime, data]) => `<tr><th>${title(runtime)}</th>${["input", "cacheRead", "cacheWrite", "output", "reasoning"].map((key) => `<td>${integer(data.tokens[key]?.total)}<small>Median ${integer(data.tokens[key]?.median)}</small></td>`).join("")}</tr>`).join("")
const toolRows = Object.entries(byRuntime).map(([runtime, data]) => `<tr><th>${title(runtime)}</th><td>${data.toolEvents}</td><td>${Object.entries(data.toolCategories).map(([key, value]) => `${escape(key)}: ${value}`).join(" · ") || "—"}</td><td>${Object.entries(data.toolNames).map(([key, value]) => `${escape(key)}: ${value}`).join(" · ") || "—"}</td></tr>`).join("")
const runRows = rows.map((row) => `<tr><th>${escape(taskTitle(row.taskId))}</th><td>${title(row.runtime)} #${row.attempt}</td><td class="${row.outcome === "pass" ? "pass" : "fail"}">${escape(row.outcome)} / ${row.score}</td><td>${row.normalCompletion ? "Yes" : "No"}${row.timedOut ? " (timeout)" : ""}</td><td>${num(row.wallSeconds)} s</td><td>${integer(row.totalTokens)}</td><td>$${num(row.apiEquivalentUsd, 4)}</td><td><a href="${escape(row.artifacts.patch)}">Patch</a> · <a href="${escape(row.artifacts.stdout)}">Events</a> · <a href="${escape(row.artifacts.checks)}">Tests</a> · <a href="${escape(row.artifacts.result)}">Result</a></td></tr>`).join("")
const validationResults = record(validation)?.results
const validationTable = Array.isArray(validationResults) ? `<table><thead><tr><th>Runtime</th><th>Validated attempts</th><th>Extra behavior checks</th><th>Source type checks</th><th>Code reviews</th></tr></thead><tbody>${["vector", "codex"].map((runtime) => {
  const selected = validationResults.map(record).filter((item) => item?.runtime === runtime)
  return `<tr><th>${title(runtime)}</th><td>${selected.length}</td><td>${selected.filter((item) => item?.behaviorPass === true).length}/${selected.length}</td><td>${selected.filter((item) => item?.typecheckPass === true).length}/${selected.length}</td><td>${selected.filter((item) => record(item?.codeQuality)?.status === "reviewed").length}/${selected.length}</td></tr>`
}).join("")}</tbody></table>` : ""
const evidenceLinks = [modelEvidence === undefined ? "" : link(modelEvidencePath, "Actual model and reasoning evidence"), sourceIntegrity === undefined ? "" : link(sourceIntegrityPath, "Source integrity verification"), authContext === undefined ? "" : link(authContextPath, "Redacted account comparison")].filter(Boolean).join(" · ")
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vector vs Codex — local benchmark</title><style>
:root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172338;background:#f4f6fa;font-size:15px}body{max-width:1420px;margin:auto;padding:42px 28px 64px}h1{font-size:38px;letter-spacing:-1.2px;margin:10px 0}h2{font-size:21px;margin:0 0 16px}p{line-height:1.6;max-width:1100px}.eyebrow{letter-spacing:2px;text-transform:uppercase;font-size:12px;color:#3b658e}.status{display:inline-block;padding:6px 10px;border-radius:6px;background:${complete ? "#d8f0e4" : "#fff0c2"};font-size:13px;font-weight:650}.lede{font-size:18px;color:#45566c}.card{background:white;border:1px solid #dde4ec;border-radius:12px;margin-top:24px;padding:24px;overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}th,td{padding:13px 11px;border-bottom:1px solid #e4e9f0;vertical-align:top;text-align:left}thead th{font-size:11px;text-transform:uppercase;color:#52667f;letter-spacing:.5px;background:#f8fafc}tbody th{font-weight:620}small{display:block;color:#6b788a;font-size:11px;margin-top:3px;white-space:nowrap}.note{font-size:13px;color:#617188}.pass{color:#146340}.fail{color:#a02f30}a{color:#245ea4;text-decoration:none}a:hover{text-decoration:underline}code{font-family:ui-monospace,monospace;font-size:12px;overflow-wrap:anywhere}li{line-height:1.6;margin:7px 0}pre{font-size:12px;white-space:pre-wrap;max-height:500px;overflow:auto}footer{font-size:12px;color:#68788a;margin-top:28px}@media(max-width:750px){body{padding:25px 12px}h1{font-size:29px}.card{padding:16px}}
</style><header><div class="eyebrow">Controlled local comparison · 7 October 2026</div><h1>Vector and Codex</h1><span class="status">${complete ? "Complete" : "Partial — benchmark still running"}: ${rows.length}/${expectedRuns} runs recorded</span><p class="lede">Same model, same tasks, independently checked code. Timing, token use, estimated API cost, memory, and edit size are reported separately.</p><p><strong>Model:</strong> GPT-6.1 Sol · <strong>Reasoning:</strong> medium · <strong>Design:</strong> ${report.tasks.length} tasks × ${report.repetitions} attempts × 2 runtimes.</p><p class="note">No overall winner is assigned here. The independent code review and the limitations below matter alongside these measurements.</p></header>
<section class="card"><h2>Across the recorded runs</h2><table><thead><tr><th>Runtime</th><th>Passes</th><th>Normal completion</th><th>Total time</th><th>Median time (range)</th><th>Total tokens</th><th>Estimated API cost</th><th>Median sampled peak memory</th><th>Tool events</th></tr></thead><tbody>${runtimeRows}</tbody></table><p class="note">A pass means the protected tests and task assertions pass. Normal completion additionally requires a zero CLI exit, no timeout, and no reported runtime errors. Tokens and price totals include ${rows.filter((row) => row.tokens).length}/${rows.length} runs with usage data.</p></section>
<section class="card"><h2>Task results</h2><table><thead><tr><th>Task</th><th>Runtime</th><th>Passes</th><th>Median time (range)</th><th>Median tokens (range)</th><th>Median API estimate (range)</th><th>Median source files</th><th>Median source lines (range)</th></tr></thead><tbody>${taskRows}</tbody></table><p class="note">Source edits are additions and deletions in the task's expected files. Smaller edits are a scope measurement; they are not automatically better code. Braces and whitespace can change line counts without changing the implementation; the independent review identifies such cases.</p></section>
<section class="card"><h2>Token use and estimated cost</h2><table><thead><tr><th>Runtime</th><th>Uncached input</th><th>Cache reads</th><th>Cache writes</th><th>Output</th><th>Reasoning within output</th></tr></thead><tbody>${tokenRows}</tbody></table><p>Estimates use <a href="${PRICE_URL}">OpenAI's standard short-context API prices</a>, verified on 7 October 2026: $2.00 input, $0.10 cached input, $2.50 cache writes, and $10.00 output per million tokens. Reasoning is already included in output.</p><p class="note"><strong>Actual billed cost is unknown.</strong> Both sign-ins use ChatGPT accounts. These token-based API-equivalent estimates do not state how much either subscription was charged.</p></section>
<section class="card"><h2>Execution shape</h2><table><thead><tr><th>Runtime</th><th>Events</th><th>Broad categories</th><th>Native tool/event names</th></tr></thead><tbody>${toolRows}</tbody></table><p class="note">One shell call can do multiple things. Vector and Codex expose different event schemas, so these counts are not equivalent units of work. Memory is the sum of descendant-process RSS sampled every 500ms; shared pages can count more than once.</p></section>
<section class="card"><h2>Every attempt and its evidence</h2><table><thead><tr><th>Task</th><th>Attempt</th><th>Objective result</th><th>Normal completion</th><th>Time</th><th>Tokens</th><th>API estimate</th><th>Evidence</th></tr></thead><tbody>${runRows}</tbody></table><p>${link(source, "Full raw report")} · ${link(join(ROOT, "summary.json"), "Computed summary")} · ${link(join(ROOT, "runner.ts"), "Runner")} · ${link(join(ROOT, "analysis.ts"), "Analysis script")}</p></section>
<section class="card"><h2>Independent validation</h2>${validation === undefined ? "<p>Additional validation has not been recorded yet. This page currently reports the built-in fixture checks.</p>" : `<p>${link(validationPath, "Read independent validation")}</p>${validationTable}<details><summary>Validation details</summary><pre>${escape(JSON.stringify(validation, null, 2))}</pre></details>`}</section>
<section class="card"><h2>Method and limits</h2><p><strong>Vector commit:</strong> <code>${escape(report.metadata.vectorCommit)}</code><br><strong>Build:</strong> ${escape(report.metadata.vectorBuild)}<br><strong>Codex CLI:</strong> ${escape(report.metadata.codexVersion)}</p><p>${evidenceLinks}</p><ul>${summary.methodology.map((item) => `<li>${escape(item)}</li>`).join("")}</ul><ul>${summary.limitations.map((item) => `<li>${escape(item)}</li>`).join("")}</ul></section><footer>Generated ${escape(summary.generatedAt)} · Included source: ${escape(relative(ROOT, source))} · Preflights and the excluded initial run are not counted.</footer></html>`
await Bun.write(join(ROOT, "report.html"), html)
console.log(JSON.stringify({ state: summary.state, completed: rows.length, expected: expectedRuns, summary: join(ROOT, "summary.json"), html: join(ROOT, "report.html") }, null, 2))
