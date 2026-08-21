import { execFile } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { join } from "node:path"
import { untrustedChildEnvironment } from "@opencode-ai/core/child-environment"

const MAX_OUTPUT_BYTES = 80_000
const DEFAULT_TIMEOUT_MS = 120_000

export type GuardrailCheck = {
  id: string
  label: string
  command: string
  args: string[]
  reason: string
}

export type GuardrailCheckResult = GuardrailCheck & {
  status: "passed" | "failed" | "skipped"
  exitCode?: number
  durationMs: number
  output: string
}

export type WorkspaceValidationReport = {
  startedAt: string
  completedAt: string
  passed: boolean
  hadChecks: boolean
  checks: GuardrailCheckResult[]
  failureSummary: string
}

function commandLabel(command: string, args: string[]) {
  return [command, ...args].join(" ")
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  )
}

function safeScript(script: string | undefined) {
  if (!script) return false
  return !/no tests?|not implemented|echo\s+["']?error/i.test(script)
}

function packageRunner(root: string) {
  return Promise.all([
    exists(join(root, "bun.lock")),
    exists(join(root, "bun.lockb")),
    exists(join(root, "pnpm-lock.yaml")),
    exists(join(root, "yarn.lock")),
  ]).then(([bunLock, bunLockb, pnpmLock, yarnLock]) => {
    if (bunLock || bunLockb) return { command: "bun", args: (script: string) => ["run", script] }
    if (pnpmLock) return { command: "pnpm", args: (script: string) => ["run", script] }
    if (yarnLock) return { command: "yarn", args: (script: string) => [script] }
    return { command: "npm", args: (script: string) => ["run", script, "--"] }
  })
}

export async function detectWorkspaceChecks(root: string, changedFiles: string[] = []): Promise<GuardrailCheck[]> {
  const checks: GuardrailCheck[] = []
  const packagePath = join(root, "package.json")
  if (await exists(packagePath)) {
    const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, string> }
    const scripts = parsed.scripts ?? {}
    const runner = await packageRunner(root)
    const preferred = [
      ["typecheck", "Type checking catches cross-file contract errors"],
      ["check", "Project checks validate framework and compiler contracts"],
      ["test", "Tests verify behavior deterministically"],
      ["lint", "Linting catches invalid and unsafe source patterns"],
      ["build", "A production build verifies imports and bundler integration"],
    ] as const
    const added = new Set<string>()
    for (const [script, reason] of preferred) {
      if (checks.length >= 4 || added.has(script) || !safeScript(scripts[script])) continue
      checks.push({
        id: `package:${script}`,
        label: script === "typecheck" ? "Typecheck" : `${script[0]!.toUpperCase()}${script.slice(1)}`,
        command: runner.command,
        args: runner.args(script),
        reason,
      })
      added.add(script)
    }
  }

  const hasPython = changedFiles.some((file) => file.endsWith(".py")) || (await exists(join(root, "pyproject.toml")))
  if (hasPython) {
    checks.push({
      id: "python:compile",
      label: "Python syntax",
      command: "python3",
      args: ["-m", "compileall", "-q", "-x", "(^|/)(node_modules|dist|build|\.git)/", "."],
      reason: "Python bytecode compilation deterministically validates syntax",
    })
    if ((await exists(join(root, "pytest.ini"))) || (await exists(join(root, "tests")))) {
      checks.push({
        id: "python:pytest",
        label: "Pytest",
        command: "python3",
        args: ["-m", "pytest", "-q", "--maxfail=1"],
        reason: "The repository includes an explicit Python test suite",
      })
    }
  }
  if (await exists(join(root, "Cargo.toml"))) {
    checks.push({
      id: "rust:check",
      label: "Cargo check",
      command: "cargo",
      args: ["check", "--quiet"],
      reason: "Rust compiler checks provide deterministic type and borrow validation",
    })
  }
  if (await exists(join(root, "go.mod"))) {
    checks.push({
      id: "go:test",
      label: "Go test",
      command: "go",
      args: ["test", "./..."],
      reason: "Go test compiles packages and runs the repository test suite",
    })
  }
  return checks.slice(0, 5)
}

function runCheck(check: GuardrailCheck, root: string, timeoutMs: number): Promise<GuardrailCheckResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = execFile(
      check.command,
      check.args,
      {
        cwd: root,
        env: untrustedChildEnvironment(process.env, { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" }),
        maxBuffer: MAX_OUTPUT_BYTES * 4,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        const raw = `${stdout || ""}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`
        const output = raw.length > MAX_OUTPUT_BYTES ? `${raw.slice(0, MAX_OUTPUT_BYTES)}\n… output truncated` : raw
        // ENOENT covers a missing runner, but the common case in an isolated
        // workspace is a runner that exists and a project-local binary that
        // does not: a git worktree never carries gitignored node_modules, so
        // `bun run typecheck` exits 127 with "command not found". Treating that
        // as a failure made every merge, selective merge and PR unreachable for
        // any project with local dev dependencies — this repository included.
        const exitCode = typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? Number(error!.code) : undefined
        const notInstalled = exitCode === 127 || /command not found|: not found\b/i.test(raw)
        const missing = (error as NodeJS.ErrnoException | null)?.code === "ENOENT" || (Boolean(error) && notInstalled)
        resolve({
          ...check,
          status: missing ? "skipped" : error ? "failed" : "passed",
          exitCode: typeof (error as any)?.code === "number" ? (error as any).code : error ? 1 : 0,
          durationMs: Date.now() - started,
          output: missing
            ? `${check.command} could not run in this isolated workspace (a tool it needs is not installed there), so ${check.label} was skipped.`
            : output.trim() || (error ? String(error) : `${check.label} passed.`),
        })
      },
    )
    child.stdin?.end()
  })
}

export async function validateWorkspace(
  root: string,
  changedFiles: string[] = [],
  options: { timeoutMs?: number } = {},
): Promise<WorkspaceValidationReport> {
  const startedAt = new Date().toISOString()
  const checks = await detectWorkspaceChecks(root, changedFiles)
  const results: GuardrailCheckResult[] = []
  for (const check of checks) {
    results.push(await runCheck(check, root, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
    if (results.at(-1)?.status === "failed") break
  }
  const failures = results.filter((result) => result.status === "failed")
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    passed: failures.length === 0,
    hadChecks: results.some((result) => result.status !== "skipped"),
    checks: results,
    failureSummary: failures
      .map((failure) => `${commandLabel(failure.command, failure.args)} failed:\n${failure.output.slice(-12_000)}`)
      .join("\n\n"),
  }
}

export function formatValidationForRepair(report: WorkspaceValidationReport) {
  if (report.passed) return "All deterministic validation checks passed."
  return [
    "Vector's deterministic guardrails found a validation failure after your edits.",
    "Repair only the failure introduced or exposed by this task. Preserve unrelated existing behavior.",
    "Run the relevant check again before finishing.",
    "",
    report.failureSummary,
  ].join("\n")
}
