import { spawn } from "node:child_process"
import { stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"

import {
  checkDeployment,
  getBuildSettings,
  getDeployment,
  markDeploymentPromoted,
  recordDeployment,
  redactCloudLog,
  updateDeployment,
  upsertDeploymentCheck,
  type CloudBuildSettings,
  type CloudDeployment,
  type CloudDeploymentCheck,
  type CloudGitMetadata,
} from "./cloud-console"
import { scanProjectSecrets } from "./secret-scanner"
import {
  cachedCloudProviderConnection,
  getCloudProviderProjectLink,
  getCloudProviderRuntimeAuth,
} from "./cloud-connections"
import { extractDeployUrl } from "./publish-url"
import { agentEnvironment, resolveAgentPath, runCli, shimmedCommand } from "./external-agents"

// Publish the user's app straight from the Preview panel — Lovable-style, but
// BYOK like everything else in Vector: deploys go to the USER's own Vercel
// account through their CLI login. Vector never proxies the code.

export type PublishTargetId = "vercel"

export type PublishTarget = {
  id: PublishTargetId
  label: string
  command: string[]
  loginHint: string
  available: boolean
  /** The logged-in account (e.g. Vercel username), when detectable. */
  account?: string
}

export type PublishResult = {
  ok: boolean
  url?: string
  target: string
  log: string
  error?: string
  deploymentId?: string
  checks?: CloudDeploymentCheck[]
}

export type PublishProjectInput = {
  projectPath: string
  taskId?: string
  scopeProjectPath?: string
  scopeTaskId?: string
  workspaceId?: string
  workspaceName?: string
  target: PublishTargetId
  production?: boolean
  runId?: string
}

export type PublishProgressEvent = {
  runId: string
  stage:
    | "preparing"
    | "installing"
    | "testing"
    | "building"
    | "uploading"
    | "checking"
    | "promoting"
    | "complete"
    | "failed"
  level: "info" | "success" | "warning" | "error"
  message: string
  at: string
}

export type PublishProgressEmitter = (event: PublishProgressEvent) => void

export type CloudRuntimeLogResult = {
  log: string
  fetchedAt: string
  source: "provider" | "build"
}

const activePublishes = new Set<string>()

function scopeFor(input: PublishProjectInput) {
  return {
    projectPath: input.scopeProjectPath ?? input.projectPath,
    taskId: input.scopeTaskId ?? input.taskId,
  }
}

function emitProgress(
  input: PublishProjectInput,
  emit: PublishProgressEmitter | undefined,
  stage: PublishProgressEvent["stage"],
  level: PublishProgressEvent["level"],
  message: string,
) {
  if (!emit || !input.runId) return
  emit({ runId: input.runId, stage, level, message, at: new Date().toISOString() })
}

// `path` is what resolveAgentPath found. npm installs vercel and npx as .cmd shims on Windows: a bare name
// never finds them there (libuv's PATH search only tries .com and .exe), and Node will not run a .cmd itself, so
// runCli launches it through cmd.exe.
function execOk(path: string | undefined, args: string[]) {
  if (!path) return Promise.resolve(false)
  return runCli(path, args, 10_000, agentEnvironment()).then((result) => !result.failed)
}

// Capture stdout so we can read the logged-in account (`vercel whoami`).
// Read-only; returns undefined when the CLI is missing or not logged in.
function execOut(path: string | undefined, args: string[]) {
  if (!path) return Promise.resolve(undefined)
  return runCli(path, args, 10_000, agentEnvironment()).then((result) =>
    result.failed ? undefined : result.stdout.trim() || undefined,
  )
}

function runProcess(input: {
  command: string
  args?: string[]
  cwd: string
  timeoutMs?: number
  shell?: boolean
  windowsVerbatimArguments?: boolean
  onOutput?: (output: string) => void
  env?: NodeJS.ProcessEnv
}) {
  return new Promise<{ ok: boolean; code: number | null; signal: NodeJS.Signals | null; log: string }>((resolve) => {
    const child = spawn(input.command, input.args ?? [], {
      cwd: input.cwd,
      env: untrustedChildEnvironment(process.env, input.env, { CI: "1", FORCE_COLOR: "0" }),
      shell: input.shell,
      windowsVerbatimArguments: input.windowsVerbatimArguments,
    })
    let output = ""
    const capture = (chunk: Buffer) => {
      const text = chunk.toString()
      output = (output + text).slice(-40_000)
      input.onOutput?.(text)
    }
    child.stdout?.on("data", capture)
    child.stderr?.on("data", capture)
    const timeout = setTimeout(() => child.kill("SIGTERM"), input.timeoutMs ?? 10 * 60_000)
    child.on("close", (code, signal) => {
      clearTimeout(timeout)
      resolve({
        ok: code === 0 && !signal,
        code,
        signal,
        log: signal ? `${output}\nCommand timed out.` : output,
      })
    })
    child.on("error", (error) => {
      clearTimeout(timeout)
      resolve({ ok: false, code: null, signal: null, log: `${output}\n${error.message}` })
    })
  })
}

// Runs the Vercel CLI with the user's token as VERCEL_TOKEN. A Vercel token is a
// plain string with no prefix a pattern could recognise, so every chunk the CLI
// prints is scrubbed of that exact string before it is streamed, logged or
// returned. The tail of each chunk is held back until the next one, so a token
// split across two chunks is still caught.
export async function runVercel(input: {
  command: string[]
  args: string[]
  cwd: string
  token?: string
  timeoutMs?: number
  onOutput?: (output: string) => void
}) {
  const token = input.token ?? ""
  const scrub = (text: string) => (token ? text.split(token).join("[redacted]") : text)
  let pending = ""
  const flush = (text: string, final: boolean) => {
    const combined = scrub(pending + text)
    const held = final || !token ? 0 : Math.min(combined.length, token.length - 1)
    pending = combined.slice(combined.length - held)
    const ready = combined.slice(0, combined.length - held)
    if (ready) input.onOutput?.(ready)
  }
  const launch = shimmedCommand(input.command[0], [...input.command.slice(1), ...input.args])
  const result = await runProcess({
    command: launch.command,
    args: launch.args,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    env: token ? { VERCEL_TOKEN: token } : undefined,
    onOutput: (text) => flush(text, false),
  })
  flush("", true)
  return { ...result, log: scrub(result.log) }
}

export async function detectPublishTargets(): Promise<PublishTarget[]> {
  const vercelConnection = cachedCloudProviderConnection("vercel")
  // Each is the CLI's resolved path when it runs, so a deploy launches exactly what was detected.
  const [vercel, npx] = await Promise.all(
    ["vercel", "npx"].map(async (cli) => {
      const path = await resolveAgentPath(cli, agentEnvironment())
      return (await execOk(path, ["--version"])) ? path : undefined
    }),
  )
  // Only ask who's logged in when the CLI is actually installed.
  const vercelAccount = vercel
    ? await execOut(vercel, ["whoami"])
    : npx
      ? await execOut(npx, ["--yes", "vercel", "whoami"])
      : undefined
  return [
    {
      id: "vercel",
      label: vercel ? "Vercel" : "Vercel (via npx)",
      command: vercel ? [vercel] : [npx ?? "npx", "--yes", "vercel"],
      loginHint: !(vercel || npx)
        ? "Publishing runs the Vercel deploy through Node.js (npx), which is not installed on this machine. Install Node.js from nodejs.org, then publish again."
        : vercelConnection.connected
          ? "Connected through Vector Cloud."
          : "Connect Vercel in Vector Cloud > Connections with an access token.",
      available: Boolean(vercel || npx) && Boolean(vercelConnection.connected || vercelAccount),
      account: vercelConnection.account ?? vercelAccount,
    },
  ]
}

// The directory that actually ships. Publish-time checks have to look here and
// not only at the project root: a bundler bakes VITE_*/NEXT_PUBLIC_* values into
// these files, and a scan of the source never sees them. Returns undefined when
// the project publishes from its own root, as a plain static site does.
async function resolveDeployRoot(projectPath: string, configuredOutput?: string) {
  if (configuredOutput && configuredOutput !== ".") {
    const configuredRoot = join(projectPath, configuredOutput)
    return (await stat(configuredRoot).catch(() => undefined))?.isDirectory() ? configuredRoot : undefined
  }
  for (const candidate of ["dist", "build", "out"]) {
    if (await stat(join(projectPath, candidate, "index.html")).catch(() => undefined)) {
      return join(projectPath, candidate)
    }
  }
  return undefined
}

function runBuild(command: string, projectPath: string, onOutput?: (output: string) => void) {
  return runProcess({ command, cwd: projectPath, shell: true, onOutput })
}

async function readGitMetadata(projectPath: string): Promise<CloudGitMetadata | undefined> {
  const read = (args: string[]) =>
    runProcess({ command: "git", args, cwd: projectPath, timeoutMs: 10_000 }).then((result) =>
      result.ok ? result.log.trim() : "",
    )
  const [commitSha, branch, commitMessage, remoteUrl, status] = await Promise.all([
    read(["rev-parse", "HEAD"]),
    read(["branch", "--show-current"]),
    read(["log", "-1", "--pretty=%s"]),
    read(["config", "--get", "remote.origin.url"]),
    read(["status", "--porcelain"]),
  ])
  if (!commitSha) return undefined
  return {
    branch: branch || "detached",
    commitSha,
    commitShort: commitSha.slice(0, 8),
    commitMessage: commitMessage || "No commit message",
    remoteUrl: sanitizeGitRemote(remoteUrl) || undefined,
    dirty: Boolean(status),
  }
}

function sanitizeGitRemote(value: string): string {
  if (!value) return ""
  return value.replace(/^(https?:\/\/)[^/@]+@/i, "$1")
}

function makeCheck(input: Omit<CloudDeploymentCheck, "checkedAt">): CloudDeploymentCheck {
  return { ...input, checkedAt: new Date().toISOString() }
}

function commandCheck(
  type: "install" | "test" | "build",
  label: string,
  required: boolean,
  result: { ok: boolean; log: string },
  durationMs: number,
): CloudDeploymentCheck {
  return makeCheck({
    id: type,
    type,
    label,
    status: result.ok ? "passed" : "failed",
    required,
    details: result.ok ? `${label} completed successfully.` : `${label} failed.`,
    output: result.log.slice(-20_000),
    durationMs,
  })
}

async function runPreflightChecks(
  input: PublishProjectInput,
  settings: CloudBuildSettings | null,
  emit?: PublishProgressEmitter,
) {
  const scope = scopeFor(input)
  const checks: CloudDeploymentCheck[] = []
  const logs: string[] = []
  const run = async (
    type: "install" | "test" | "build",
    command: string,
    required: boolean,
    stage: PublishProgressEvent["stage"],
    label: string,
  ) => {
    if (!command) {
      checks.push(
        makeCheck({
          id: type,
          type,
          label,
          status: required ? "failed" : "skipped",
          required,
          details: required
            ? `Configure a ${label.toLowerCase()} command in Build & runtime.`
            : "No command configured.",
        }),
      )
      return !required
    }
    emitProgress(input, emit, stage, "info", `${label}: ${command}`)
    const startedAt = Date.now()
    const result = await runBuild(command, input.projectPath, (output) => {
      const text = redactCloudLog(scope.projectPath, scope.taskId, output).trim()
      if (text) emitProgress(input, emit, stage, "info", text.slice(-800))
    })
    // A failed preflight returns its checks straight to the agent and the
    // preview panel, before any deployment record would redact them.
    const check = commandCheck(
      type,
      label,
      required,
      { ok: result.ok, log: redactCloudLog(scope.projectPath, scope.taskId, result.log) },
      Date.now() - startedAt,
    )
    checks.push(check)
    if (result.log.trim()) logs.push(result.log.trim())
    emitProgress(input, emit, stage, result.ok ? "success" : "error", check.details ?? label)
    return result.ok
  }

  if (settings?.installCommand) {
    const installed = await run("install", settings.installCommand, true, "installing", "Install dependencies")
    if (!installed) return { ok: false, checks, log: logs.join("\n") }
  } else {
    checks.push(
      makeCheck({
        id: "install",
        type: "install",
        label: "Install dependencies",
        status: "skipped",
        required: false,
        details: "No install command configured.",
      }),
    )
  }

  const testsPassed = await run(
    "test",
    settings?.testCommand ?? "",
    settings?.requiredChecks.test ?? false,
    "testing",
    "Test suite",
  )
  if (!testsPassed) return { ok: false, checks, log: logs.join("\n") }

  const buildPassed = await run(
    "build",
    settings?.buildCommand ?? "",
    Boolean(settings?.buildCommand),
    "building",
    "Production build",
  )
  if (!buildPassed) return { ok: false, checks, log: logs.join("\n") }

  emitProgress(input, emit, "checking", "info", "Scanning deployable source for exposed secrets.")
  const secretStartedAt = Date.now()
  // The build just ran, so scan what it produced as well as the source. The
  // source scan skips dist/build/out by design, and that is exactly where a
  // bundler bakes a VITE_*/NEXT_PUBLIC_* value into a file this publish then
  // uploads and serves publicly — the leak this gate is advertised to stop.
  const deployRoot = await resolveDeployRoot(input.projectPath, settings?.outputDirectory)
  const findings = (
    await Promise.all([
      scanProjectSecrets(input.projectPath),
      deployRoot ? scanProjectSecrets(deployRoot, input.projectPath) : [],
    ])
  ).flat()
  const secretsRequired = settings?.requiredChecks.secrets ?? true
  checks.push(
    makeCheck({
      id: "secrets",
      type: "secrets",
      label: "Secret scan",
      status: findings.length ? "failed" : "passed",
      required: secretsRequired,
      details: findings.length
        ? `${findings.length} possible secret${findings.length === 1 ? "" : "s"} found.`
        : "No embedded credentials detected in deployable source.",
      output: findings
        .slice(0, 50)
        .map((item) => `${item.file}:${item.line} · ${item.kind}`)
        .join("\n"),
      durationMs: Date.now() - secretStartedAt,
    }),
  )
  emitProgress(
    input,
    emit,
    "checking",
    findings.length ? "error" : "success",
    findings.length ? "Secret scan blocked this release." : "Secret scan passed.",
  )
  return {
    ok: !secretsRequired || findings.length === 0,
    checks,
    log: logs.join("\n"),
  }
}

function requiredChecksPassed(checks: CloudDeploymentCheck[]): boolean {
  return checks.every((check) => !check.required || check.status === "passed" || check.status === "skipped")
}

async function runPostDeployChecks(
  input: PublishProjectInput,
  deployment: CloudDeployment,
  settings: CloudBuildSettings | null,
  emit?: PublishProgressEmitter,
) {
  const scope = scopeFor(input)
  let current = deployment
  if (settings?.requiredChecks.health ?? true) {
    emitProgress(input, emit, "checking", "info", `Checking ${settings?.healthPath ?? "/"} on the deployed app.`)
    current = await checkDeployment(scope.projectPath, scope.taskId, current.id)
    const health = current.checks.find((check) => check.id === "health")
    emitProgress(
      input,
      emit,
      "checking",
      health?.status === "passed" ? "success" : "error",
      health?.details ?? "Health check failed.",
    )
  }
  if (!(settings?.requiredChecks.browser ?? true)) {
    return updateDeployment(scope.projectPath, scope.taskId, current.id, {
      checks: upsertDeploymentCheck(
        current.checks,
        makeCheck({
          id: "browser",
          type: "browser",
          label: "Browser smoke test",
          status: "skipped",
          required: false,
          details: "Browser smoke testing is disabled in Build & runtime.",
        }),
      ),
    })
  }

  emitProgress(input, emit, "checking", "info", "Rendering the deployment in Vector's isolated browser.")
  const { runCloudBrowserCheck } = await import("./cloud-browser-check")
  const browser = await runCloudBrowserCheck(current.url, current.id)
  current = updateDeployment(scope.projectPath, scope.taskId, current.id, {
    checks: upsertDeploymentCheck(
      current.checks,
      makeCheck({
        id: "browser",
        type: "browser",
        label: "Browser smoke test",
        status: browser.ok ? "passed" : "failed",
        required: true,
        details: browser.details,
        output: browser.output,
        durationMs: browser.durationMs,
        screenshotPath: browser.screenshotPath,
      }),
    ),
  })
  emitProgress(input, emit, "checking", browser.ok ? "success" : "error", browser.details)
  return current
}

// `targets` is the CLI detection; a test passes a stand-in for the Vercel CLI.
export async function publishProject(
  input: PublishProjectInput,
  emit?: PublishProgressEmitter,
  targets: () => Promise<PublishTarget[]> = detectPublishTargets,
): Promise<PublishResult> {
  const scope = scopeFor(input)
  const publishKey = `${input.projectPath}:${input.target}`
  const directory = input.projectPath
  if (!directory || !(await stat(directory).catch(() => undefined))?.isDirectory()) {
    return { ok: false, target: input.target, log: "", error: "Open a project before publishing." }
  }
  if (
    !(await stat(join(directory, "package.json")).catch(() => undefined)) &&
    !(await stat(join(directory, "index.html")).catch(() => undefined))
  ) {
    return {
      ok: false,
      target: input.target,
      log: "",
      error: "This project has no package.json or index.html to publish yet.",
    }
  }
  if (activePublishes.has(publishKey)) {
    return { ok: false, target: input.target, log: "", error: "A publish is already running for this project." }
  }

  const target = (await targets()).find((item) => item.id === input.target)
  if (!target?.available) {
    return {
      ok: false,
      target: input.target,
      log: "",
      error: target?.loginHint || "Connect Vercel in Vector Cloud > Connections with an access token.",
    }
  }
  if (target.id !== "vercel") {
    return { ok: false, target: target.id, log: "", error: "Unsupported publish target." }
  }
  const providerAuth = await getCloudProviderRuntimeAuth(target.id)
  const providerLink = getCloudProviderProjectLink(scope.projectPath, scope.taskId, target.id)
  if (providerAuth.token && !providerLink) {
    return {
      ok: false,
      target: target.id,
      log: "",
      error: "Link a Vercel project in Vector Cloud > Connections before publishing.",
    }
  }

  const startedAt = Date.now()
  const settings = getBuildSettings(scope.projectPath, scope.taskId)
  emitProgress(
    input,
    emit,
    "preparing",
    "info",
    `Preparing ${input.workspaceName ?? basename(directory)} for ${target.label}.`,
  )
  const preflight = await runPreflightChecks(input, settings, emit)
  const preflightLog = redactCloudLog(scope.projectPath, scope.taskId, preflight.log).slice(-40_000)
  if (!preflight.ok) {
    emitProgress(input, emit, "failed", "error", "Required pre-deploy checks failed.")
    return {
      ok: false,
      target: target.id,
      log: preflightLog,
      checks: preflight.checks,
      error: "Required pre-deploy checks failed. Review the evidence, repair the project, and publish again.",
    }
  }

  const destinationArgs = providerLink
    ? ["--project", providerLink.projectId, ...(providerLink.accountId ? ["--scope", providerLink.accountId] : [])]
    : []
  emitProgress(input, emit, "uploading", "info", `Creating an immutable ${target.label} preview.`)

  activePublishes.add(publishKey)
  const command = await runVercel({
    command: target.command,
    args: ["--yes", ...destinationArgs],
    cwd: directory,
    token: providerAuth.token,
    onOutput: (text) => {
      const redacted = redactCloudLog(scope.projectPath, scope.taskId, text).trim()
      if (redacted) emitProgress(input, emit, "uploading", "info", redacted.slice(-800))
    },
  }).finally(() => activePublishes.delete(publishKey))

  const commandLog = redactCloudLog(scope.projectPath, scope.taskId, command.log).slice(-40_000)
  const log = [preflightLog.trim(), commandLog.trim()].filter(Boolean).join("\n")
  if (command.signal) {
    emitProgress(input, emit, "failed", "error", "Publish timed out after 10 minutes.")
    return { ok: false, target: target.id, log, checks: preflight.checks, error: "Publish timed out after 10 minutes." }
  }
  const url = extractDeployUrl(command.log)
  if (!command.ok || !url) {
    const needsLogin = /not (?:logged|authenticated)|no existing credentials|please login|vercel login/i.test(
      command.log,
    )
    const error = needsLogin
      ? providerAuth.token
        ? "Vercel rejected the saved access token. Reconnect Vercel in Vector Cloud > Connections, then publish again."
        : "You are not signed in to Vercel. Connect Vercel in Vector Cloud > Connections with an access token, then publish again."
      : command.ok
        ? "The deploy finished but no URL was found in the output."
        : `${target.label} exited with code ${command.code}.`
    emitProgress(input, emit, "failed", "error", error)
    return { ok: false, target: target.id, log, checks: preflight.checks, error }
  }

  const parsed = new URL(url)
  let deployment = recordDeployment({
    slug: parsed.hostname.replace(/\./g, "-") || basename(directory),
    url,
    name: input.workspaceName ?? basename(scope.projectPath),
    projectPath: scope.projectPath,
    taskId: scope.taskId,
    deploymentPath: directory,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    target: target.id,
    environment: "preview",
    log,
    durationMs: Date.now() - startedAt,
    checks: preflight.checks,
    git: await readGitMetadata(directory),
  })
  emitProgress(input, emit, "uploading", "success", `Deployment available at ${url}`)
  deployment = await runPostDeployChecks(input, deployment, settings, emit)
  if (!requiredChecksPassed(deployment.checks)) {
    const error = "The preview deployed, but required release checks failed. Production was not changed."
    emitProgress(input, emit, "failed", "error", error)
    return {
      ok: false,
      target: target.id,
      url: deployment.url,
      log,
      deploymentId: deployment.id,
      checks: deployment.checks,
      error,
    }
  }
  if (input.production === true) {
    deployment = await promoteDeployment(
      { projectPath: scope.projectPath, taskId: scope.taskId, id: deployment.id, runId: input.runId },
      emit,
    )
  }
  emitProgress(
    input,
    emit,
    "complete",
    "success",
    input.production === true ? "Production release is live." : "Preview is ready.",
  )
  return {
    ok: true,
    target: target.id,
    url: deployment.productionUrl ?? deployment.url,
    log,
    deploymentId: deployment.id,
    checks: deployment.checks,
  }
}

export type DeploymentActionInput = {
  projectPath: string
  taskId?: string
  id: string
  runId?: string
}

async function vercelDeploymentCommand(deployment: CloudDeployment, action: "promote" | "rollback") {
  const target = (await detectPublishTargets()).find((item) => item.id === "vercel")
  if (!target?.available) throw new Error(`Vercel is unavailable. ${target?.loginHint ?? ""}`.trim())
  const auth = await getCloudProviderRuntimeAuth("vercel")
  const result = await runVercel({
    command: target.command,
    args: [action, deployment.url, "--yes"],
    cwd: deployment.deploymentPath ?? deployment.projectPath,
    token: auth.token,
  })
  if (!result.ok) throw new Error(redactCloudLog(deployment.projectPath, deployment.taskId, result.log).slice(-4_000))
  return extractDeployUrl(result.log) ?? deployment.url
}

export async function promoteDeployment(
  input: DeploymentActionInput,
  emit?: PublishProgressEmitter,
): Promise<CloudDeployment> {
  const deployment = getDeployment(input.projectPath, input.taskId, input.id)
  if (deployment.workspaceId) {
    throw new Error("Merge this agent workspace into the main project before promoting it to production.")
  }
  if (!requiredChecksPassed(deployment.checks)) {
    throw new Error("This release has failed required checks and cannot be promoted.")
  }
  const progressInput: PublishProjectInput = {
    projectPath: deployment.deploymentPath ?? deployment.projectPath,
    scopeProjectPath: deployment.projectPath,
    scopeTaskId: deployment.taskId,
    target: "vercel",
    runId: input.runId,
  }
  emitProgress(progressInput, emit, "promoting", "info", `Promoting ${deployment.url} to production.`)
  const productionUrl = await vercelDeploymentCommand(deployment, "promote")
  const promoted = markDeploymentPromoted(input.projectPath, input.taskId, input.id, { productionUrl })
  emitProgress(progressInput, emit, "promoting", "success", `Production now points to ${productionUrl}`)
  return promoted
}

export async function rollbackDeployment(
  input: DeploymentActionInput,
  emit?: PublishProgressEmitter,
): Promise<CloudDeployment> {
  const deployment = getDeployment(input.projectPath, input.taskId, input.id)
  if (deployment.releaseStatus === "current") throw new Error("That release is already live in production.")
  if (!requiredChecksPassed(deployment.checks)) {
    throw new Error("This release has failed required checks and cannot be restored.")
  }
  const progressInput: PublishProjectInput = {
    projectPath: deployment.deploymentPath ?? deployment.projectPath,
    scopeProjectPath: deployment.projectPath,
    scopeTaskId: deployment.taskId,
    target: "vercel",
    runId: input.runId,
  }
  emitProgress(progressInput, emit, "promoting", "info", `Rolling production back to ${deployment.url}.`)
  const productionUrl = await vercelDeploymentCommand(deployment, "rollback")
  const restored = markDeploymentPromoted(input.projectPath, input.taskId, input.id, {
    productionUrl,
    rollback: true,
  })
  emitProgress(progressInput, emit, "promoting", "success", `Production restored to ${productionUrl}`)
  return restored
}

export async function fetchDeploymentRuntimeLogs(input: DeploymentActionInput): Promise<CloudRuntimeLogResult> {
  const deployment = getDeployment(input.projectPath, input.taskId, input.id)
  const fetchedAt = new Date().toISOString()
  const target = (await detectPublishTargets()).find((item) => item.id === "vercel")
  if (!target?.available) throw new Error(`Vercel is unavailable. ${target?.loginHint ?? ""}`.trim())
  const auth = await getCloudProviderRuntimeAuth("vercel")
  const result = await runVercel({
    command: target.command,
    args: ["logs", "--deployment", deployment.url, "--json", "--limit", "100", "--since", "1h"],
    cwd: deployment.deploymentPath ?? deployment.projectPath,
    timeoutMs: 30_000,
    token: auth.token,
  })
  const log = redactCloudLog(deployment.projectPath, deployment.taskId, result.log).slice(-40_000)
  if (!result.ok) throw new Error(log || "Vercel logs could not be read.")
  updateDeployment(input.projectPath, input.taskId, input.id, { runtimeLog: log, runtimeLogFetchedAt: fetchedAt })
  return { log, fetchedAt, source: "provider" }
}

export async function rerunDeploymentChecks(input: DeploymentActionInput): Promise<CloudDeployment> {
  const deployment = getDeployment(input.projectPath, input.taskId, input.id)
  const settings = getBuildSettings(input.projectPath, input.taskId)
  const progressInput: PublishProjectInput = {
    projectPath: deployment.deploymentPath ?? deployment.projectPath,
    scopeProjectPath: deployment.projectPath,
    scopeTaskId: deployment.taskId,
    workspaceId: deployment.workspaceId,
    workspaceName: deployment.workspaceName,
    target: "vercel",
    runId: input.runId,
  }
  return runPostDeployChecks(progressInput, deployment, settings)
}
