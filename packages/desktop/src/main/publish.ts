import { spawn } from "node:child_process"
import { stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"

import {
  getBuildSettings,
  getDeployment,
  listDeployments,
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
import { cachedCloudProviderConnection } from "./cloud-connections"
import { extractDeployUrl } from "./publish-url"
import { agentEnvironment, resolveAgentPath, runCli, shimmedCommand } from "./external-agents"
import {
  vercelLinkContext,
  vercelRequest,
  VercelError,
  type VercelErrorCode,
  type VercelFetch,
  type VercelLinkContext,
} from "./cloud-vercel-api"
import {
  autoLinkVercelProject,
  readVercelProject,
  vercelBypassSecret,
  type VercelProtection,
} from "./cloud-vercel-projects"
import {
  assignVercelBranchAlias,
  inspectInProject,
  promoteVercelDeployment,
  vercelBuildLogs,
  type VercelDeployment,
} from "./cloud-vercel-deployments"
import { probeVercelUrl, protectionBypassHeaders } from "./cloud-vercel-checks"
import type { CloudBrowserCheckResult } from "./cloud-browser-check"

// Publish the user's app to their own Vercel account. Every release is first
// an immutable deployment that Vector checks; production only moves when the
// user asked for it and the checks passed. Vector never proxies the code.

export type PublishTargetId = "vercel"

// Deploys run this exact Vercel CLI through npx, so a release does not change
// with whatever CLI happens to be installed.
export const VERCEL_CLI_VERSION = "59.26.0"

const NO_NODE = `Publishing needs Node.js: Vector runs the Vercel CLI (vercel@${VERCEL_CLI_VERSION}) through npx, and npx was not found. Install Node.js 18 or later from nodejs.org, then publish again.`

export type PublishTarget = {
  id: PublishTargetId
  label: string
  command: string[]
  loginHint: string
  available: boolean
  /** The connected Vercel account. */
  account?: string
  /** What stops publishing on this machine. */
  problem?: "no_node" | "not_connected"
}

export type PublishErrorCode = VercelErrorCode | "checks_failed" | "build_failed" | "deploy_failed"

export type PublishResult = {
  ok: boolean
  url?: string
  target: string
  log: string
  error?: string
  errorCode?: PublishErrorCode
  deploymentId?: string
  providerDeploymentId?: string
  environment?: "preview" | "production"
  productionUrl?: string
  /** The stable per-branch preview address of an agent workspace. */
  alias?: string
  checks?: CloudDeploymentCheck[]
  /** Deployment Protection kept Vector's checks out of the deployment's own URL. */
  protectedChecks?: "skipped" | "checked-after-promotion"
  notes?: string[]
}

export type PublishOptions = {
  /** The CLI to run instead of the pinned one, for tests. */
  command?: string[]
  request?: VercelFetch
  sleep?: (ms: number) => Promise<void>
  browserCheck?: (url: string, id: string, headers: Record<string, string>) => Promise<CloudBrowserCheckResult>
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

// `path` is what resolveAgentPath found. npm installs npx as a .cmd shim on Windows: a bare name
// never finds them there (libuv's PATH search only tries .com and .exe), and Node will not run a .cmd itself, so
// runCli launches it through cmd.exe.
function execOk(path: string | undefined, args: string[]) {
  if (!path) return Promise.resolve(false)
  return runCli(path, args, 10_000, agentEnvironment()).then((result) => !result.failed)
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
  env?: NodeJS.ProcessEnv
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
    env: { ...input.env, ...(token ? { VERCEL_TOKEN: token } : {}) },
    onOutput: (text) => flush(text, false),
  })
  flush("", true)
  return { ...result, log: scrub(result.log) }
}

export async function detectPublishTargets(): Promise<PublishTarget[]> {
  const connection = cachedCloudProviderConnection("vercel")
  const command = await vercelCommand()
  const problem = !command ? ("no_node" as const) : !connection.connected ? ("not_connected" as const) : undefined
  return [
    {
      id: "vercel",
      label: "Vercel",
      command: command ?? ["npx", "--yes", `vercel@${VERCEL_CLI_VERSION}`],
      available: !problem,
      account: connection.account,
      problem,
      loginHint:
        problem === "no_node"
          ? NO_NODE
          : problem === "not_connected"
            ? "Connect Vercel in Cloud Services > Integrations to publish."
            : `Connected${connection.account ? ` as ${connection.account}` : ""}.`,
    },
  ]
}

// The pinned CLI through the user's own npx, or undefined without Node.
async function vercelCommand() {
  const npx = await resolveAgentPath("npx", agentEnvironment())
  if (!(await execOk(npx, ["--version"]))) return
  return [npx!, "--yes", `vercel@${VERCEL_CLI_VERSION}`]
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
    const check = commandCheck(type, label, required, result, Date.now() - startedAt)
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

type CheckAccess = {
  /** Protection Bypass for Automation secret, sent as a header. */
  bypass?: string
  /** Deployment Protection covers the URL being checked. */
  protectedUrl: boolean
  /** The URL is the production domain, checked because the deployment's own URL was protected. */
  afterPromotion?: boolean
}

function protectedDetail(afterPromotion: boolean) {
  return afterPromotion
    ? "Protected by Vercel Deployment Protection; checked on the production domain instead."
    : "Protected by Vercel Deployment Protection, so Vector could not open it. Enable Protection Bypass for Automation in Cloud Services > Project settings to check protected deployments."
}

// The health probe of a release check, also run on its own from Observability.
// Deployment Protection leaves the check "skipped" and the release's status
// as it was: a sign-in page says nothing about whether the app works.
async function healthCheck(
  input: PublishProjectInput,
  deployment: CloudDeployment,
  settings: CloudBuildSettings | null,
  access: CheckAccess,
  url: string,
  options: PublishOptions,
  emit?: PublishProgressEmitter,
) {
  const scope = scopeFor(input)
  const where = access.afterPromotion ? ` on ${url} after promotion` : ""
  const healthPath = settings?.healthPath ?? "/"
  emitProgress(input, emit, "checking", "info", `Checking ${healthPath}${where}.`)
  const probe = await probeVercelUrl(new URL(healthPath, url).toString(), {
    bypass: access.bypass,
    projectProtected: access.protectedUrl,
    request: options.request,
  })
  const details =
    probe.kind === "ok"
      ? `HTTP ${probe.statusCode} in ${probe.latencyMs} ms${where}`
      : probe.kind === "protected"
        ? protectedDetail(access.afterPromotion === true)
        : `${probe.error ?? "Health check failed."}${where}`
  const updated = updateDeployment(scope.projectPath, scope.taskId, deployment.id, {
    status:
      probe.kind === "ok"
        ? "ready"
        : probe.kind === "protected"
          ? deployment.status
          : probe.statusCode
            ? "degraded"
            : "unreachable",
    statusCode: probe.statusCode,
    latencyMs: probe.latencyMs,
    healthError: probe.kind === "failed" ? probe.error : undefined,
    lastCheckedAt: new Date().toISOString(),
    checks: upsertDeploymentCheck(
      deployment.checks,
      makeCheck({
        id: "health",
        type: "health",
        label: `Health check ${healthPath}`,
        status: probe.kind === "ok" ? "passed" : probe.kind === "protected" ? "skipped" : "failed",
        required: settings?.requiredChecks.health ?? true,
        details,
        durationMs: probe.latencyMs,
      }),
    ),
  })
  emitProgress(
    input,
    emit,
    "checking",
    probe.kind === "failed" ? "error" : probe.kind === "ok" ? "success" : "warning",
    details,
  )
  return { deployment: updated, kind: probe.kind }
}

// Health and browser checks against `url`. A check Deployment Protection kept
// out is "skipped" with the reason, not "failed": nothing about the release
// itself is known to be wrong.
async function runPostDeployChecks(
  input: PublishProjectInput,
  deployment: CloudDeployment,
  settings: CloudBuildSettings | null,
  access: CheckAccess,
  url: string,
  options: PublishOptions,
  emit?: PublishProgressEmitter,
) {
  const scope = scopeFor(input)
  const afterPromotion = access.afterPromotion === true
  const where = afterPromotion ? ` on ${url} after promotion` : ""
  const blockedDetail = protectedDetail(afterPromotion)
  let current = deployment
  let blocked = access.protectedUrl && !access.bypass
  if (settings?.requiredChecks.health ?? true) {
    const health = await healthCheck(input, current, settings, access, url, options, emit)
    current = health.deployment
    blocked = health.kind === "protected"
  }
  if (!(settings?.requiredChecks.browser ?? true)) {
    current = updateDeployment(scope.projectPath, scope.taskId, current.id, {
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
    return { deployment: current, blocked }
  }
  if (blocked) {
    current = updateDeployment(scope.projectPath, scope.taskId, current.id, {
      checks: upsertDeploymentCheck(
        current.checks,
        makeCheck({
          id: "browser",
          type: "browser",
          label: "Browser smoke test",
          status: "skipped",
          required: true,
          details: blockedDetail,
        }),
      ),
    })
    emitProgress(input, emit, "checking", "warning", blockedDetail)
    return { deployment: current, blocked }
  }
  emitProgress(input, emit, "checking", "info", `Rendering the deployment in Vector's isolated browser${where}.`)
  const headers = protectionBypassHeaders(access.bypass)
  const browser = options.browserCheck
    ? await options.browserCheck(url, current.id, headers)
    : await import("./cloud-browser-check").then((module) => module.runCloudBrowserCheck(url, current.id, headers))
  current = updateDeployment(scope.projectPath, scope.taskId, current.id, {
    checks: upsertDeploymentCheck(
      current.checks,
      makeCheck({
        id: "browser",
        type: "browser",
        label: "Browser smoke test",
        status: browser.ok ? "passed" : "failed",
        required: true,
        details: `${browser.details}${where}`,
        output: browser.output,
        durationMs: browser.durationMs,
        screenshotPath: browser.screenshotPath,
      }),
    ),
  })
  emitProgress(input, emit, "checking", browser.ok ? "success" : "error", browser.details)
  return { deployment: current, blocked }
}

// Vercel Authentication set to "preview" leaves production deployment URLs
// open; the stricter modes and Password Protection cover every generated URL.
function protectsDeployment(protection: VercelProtection | undefined, target: "production" | "preview") {
  if (!protection) return false
  if (protection.passwordProtection) return true
  if (!protection.vercelAuthentication) return false
  return target === "preview" || protection.vercelAuthentication !== "preview"
}

export async function publishProject(
  input: PublishProjectInput,
  emit?: PublishProgressEmitter,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const scope = scopeFor(input)
  const directory = input.projectPath
  const production = input.production === true
  const publishKey = `${scope.projectPath}:${directory}`
  const fail = (error: string, extra: Partial<PublishResult> = {}): PublishResult => {
    emitProgress(input, emit, "failed", "error", error)
    return { ok: false, target: "vercel", log: "", error, ...extra }
  }
  if (!directory || !(await stat(directory).catch(() => undefined))?.isDirectory()) {
    return fail("Open a project before publishing.")
  }
  if (
    !(await stat(join(directory, "package.json")).catch(() => undefined)) &&
    !(await stat(join(directory, "index.html")).catch(() => undefined))
  ) {
    return fail("This project has no package.json or index.html to publish yet.")
  }
  if (activePublishes.has(publishKey)) return fail("A publish is already running for this project.")

  const command = options.command ?? (await vercelCommand())
  if (!command) return fail(NO_NODE, { errorCode: "no_node" })
  const context = await prepareVercel(scope.projectPath, directory, options).catch((error: unknown) => error)
  if (!isLinkContext(context)) {
    return fail(context instanceof Error ? context.message : String(context), {
      errorCode: context instanceof VercelError ? context.code : undefined,
    })
  }

  activePublishes.add(publishKey)
  try {
    return await deployAndCheck(input, context, command, production, options, emit)
  } finally {
    activePublishes.delete(publishKey)
  }
}

function isLinkContext(value: unknown): value is VercelLinkContext {
  return Boolean(value && typeof value === "object" && "link" in value && "auth" in value)
}

// The three things a deploy needs before anything is built: a connection, a
// linked project (found from .vercel/project.json when there is one), and a
// token Vercel still accepts.
async function prepareVercel(projectPath: string, directory: string, options: PublishOptions) {
  await autoLinkVercelProject(projectPath, directory, options.request).catch(() => undefined)
  const context = await vercelLinkContext(projectPath)
  await vercelRequest(context.auth, "/v2/user", { request: options.request, unscoped: true })
  return context
}

async function deployAndCheck(
  input: PublishProjectInput,
  context: VercelLinkContext,
  command: string[],
  production: boolean,
  options: PublishOptions,
  emit?: PublishProgressEmitter,
): Promise<PublishResult> {
  const scope = scopeFor(input)
  const directory = input.projectPath
  const secrets = [context.auth.token]
  const redact = (text: string) => redactCloudLog(scope.projectPath, scope.taskId, text, secrets)
  const notes: string[] = []
  const startedAt = Date.now()
  const settings = getBuildSettings(scope.projectPath, scope.taskId)
  emitProgress(
    input,
    emit,
    "preparing",
    "info",
    `Preparing ${input.workspaceName ?? basename(directory)} for the Vercel project ${context.link.projectName}.`,
  )
  const preflight = await runPreflightChecks(input, settings, emit)
  const preflightLog = redact(preflight.log).slice(-40_000)
  if (!preflight.ok) {
    emitProgress(input, emit, "failed", "error", "Required pre-deploy checks failed.")
    return {
      ok: false,
      target: "vercel",
      log: preflightLog,
      checks: preflight.checks,
      errorCode: "checks_failed",
      error: "Required pre-deploy checks failed. Review the evidence, repair the project, and publish again.",
    }
  }

  // --skip-domain builds a production deployment without moving production's
  // domains, so the checks run before anyone is served it
  // (https://vercel.com/docs/cli/deploy#skip-domain).
  emitProgress(
    input,
    emit,
    "uploading",
    "info",
    production ? "Creating a production build on Vercel, not yet live." : "Creating a Vercel preview deployment.",
  )
  const accountId =
    context.link.accountId ?? context.auth.teamId ?? (await readVercelProject(context, options.request)).accountId
  const run = await runVercel({
    command,
    args: ["deploy", "--yes", ...(production ? ["--prod", "--skip-domain"] : [])],
    cwd: directory,
    token: context.auth.token,
    // https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel: these
    // two name the project, so the CLI neither asks nor writes .vercel/.
    env: {
      VERCEL_ORG_ID: accountId,
      VERCEL_PROJECT_ID: context.link.projectId,
      ...(options.command ? {} : { PATH: agentEnvironment().PATH }),
    },
    onOutput: (text) => {
      const redacted = redact(text).trim()
      if (redacted) emitProgress(input, emit, "uploading", "info", redacted.slice(-800))
    },
  })
  const log = [preflightLog.trim(), redact(run.log).slice(-40_000).trim()].filter(Boolean).join("\n")
  if (run.signal) {
    return {
      ...failure(input, emit, "Publish timed out after 10 minutes.", "deploy_failed"),
      log,
      checks: preflight.checks,
    }
  }
  const url = extractDeployUrl(run.log)
  if (!url) {
    const classified = classifyCliFailure(run.log, run.code, context.link.projectName)
    return { ...failure(input, emit, classified.error, classified.code), log, checks: preflight.checks }
  }
  const deployed = await inspectInProject(context, url, options.request).catch((error: unknown) => error)
  if (!deployed || deployed instanceof Error || typeof deployed !== "object") {
    const message = deployed instanceof Error ? deployed.message : "unknown error"
    return {
      ...failure(input, emit, `Vercel deployed ${url}, but Vector could not read it back: ${message}`, "deploy_failed"),
      url,
      log,
      checks: preflight.checks,
    }
  }
  const remote = deployed as VercelDeployment
  if (remote.state !== "READY") {
    const tail = await vercelBuildLogs(scope.projectPath, remote.id, 60, { request: options.request })
      .then((result) =>
        result.entries
          .toSorted((left, right) => (left.at ?? 0) - (right.at ?? 0))
          .map((entry) => entry.text)
          .join("\n"),
      )
      .catch(() => "")
    return {
      ...failure(
        input,
        emit,
        `Vercel's build ${remote.state === "CANCELED" ? "was canceled" : "failed"}${remote.errorMessage ? `: ${remote.errorMessage}` : "."} Read the build log, fix the cause and publish again.`,
        "build_failed",
      ),
      url: remote.url,
      providerDeploymentId: remote.id,
      log: [log, redact(tail)].filter(Boolean).join("\n").slice(-40_000),
      checks: preflight.checks,
    }
  }
  // Vercel makes a project's first deployment production even without --prod
  // (https://vercel.com/docs/cli/deploy#prod).
  if (!production && remote.current) {
    notes.push(
      "Vercel treats a project's first deployment as production, so this release is already live in production.",
    )
  }

  const git = await readGitMetadata(directory)
  let deployment = recordDeployment({
    slug: new URL(remote.url).hostname.replace(/\./g, "-"),
    url: remote.url,
    name: input.workspaceName ?? basename(scope.projectPath),
    projectPath: scope.projectPath,
    taskId: scope.taskId,
    deploymentPath: directory,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    target: "vercel",
    environment: remote.current ? "production" : "preview",
    log,
    durationMs: Date.now() - startedAt,
    checks: preflight.checks,
    git,
    providerDeploymentId: remote.id,
  })
  emitProgress(input, emit, "uploading", "success", `Deployment available at ${remote.url}`)

  const project = await readVercelProject(context, options.request).catch(() => undefined)
  const access: CheckAccess = {
    bypass: await vercelBypassSecret(context, options.request).catch(() => undefined),
    protectedUrl: protectsDeployment(project?.protection, remote.target),
  }
  const checked = await runPostDeployChecks(input, deployment, settings, access, remote.url, options, emit)
  deployment = checked.deployment
  if (!requiredChecksPassed(deployment.checks)) {
    return {
      ...failure(
        input,
        emit,
        remote.current
          ? "This release is live in production and its required release checks failed. Roll back if the site is broken."
          : "The deployment was built, but required release checks failed. Production was not changed.",
        "checks_failed",
      ),
      url: deployment.url,
      log,
      deploymentId: deployment.id,
      providerDeploymentId: remote.id,
      environment: remote.current ? "production" : "preview",
      checks: deployment.checks,
      notes,
    }
  }

  const alias =
    input.workspaceId && git?.branch && git.branch !== "detached"
      ? await assignVercelBranchAlias(context, remote.id, git.branch, options.request).catch((error: unknown) => {
          notes.push(
            `Vercel did not assign the branch address: ${error instanceof Error ? error.message : String(error)}`,
          )
          return undefined
        })
      : undefined
  if (alias) deployment = updateDeployment(scope.projectPath, scope.taskId, deployment.id, { alias })
  if (input.workspaceId) {
    const { recordParallelWorkspacePreview } = await import("./parallel-workspaces")
    recordParallelWorkspacePreview(input.workspaceId, alias ?? deployment.url)
  }

  if (!production || remote.current) {
    emitProgress(
      input,
      emit,
      "complete",
      "success",
      remote.current ? "Production release is live." : "Preview is ready.",
    )
    return {
      ok: true,
      target: "vercel",
      url: alias ?? deployment.url,
      log,
      deploymentId: deployment.id,
      providerDeploymentId: remote.id,
      environment: remote.current ? "production" : "preview",
      productionUrl: deployment.productionUrl,
      alias,
      checks: deployment.checks,
      protectedChecks: checked.blocked ? "skipped" : undefined,
      notes,
    }
  }

  emitProgress(input, emit, "promoting", "info", `Promoting ${remote.url} to production.`)
  const promoted = await promoteVercelDeployment(scope.projectPath, remote.id, options).catch((error: unknown) => error)
  if (promoted instanceof Error || !promoted || typeof promoted !== "object") {
    const message = promoted instanceof Error ? promoted.message : "unknown error"
    return {
      ...failure(
        input,
        emit,
        `The production build passed its checks, but promotion failed: ${message}`,
        "deploy_failed",
      ),
      url: deployment.url,
      log,
      deploymentId: deployment.id,
      providerDeploymentId: remote.id,
      checks: deployment.checks,
      notes,
    }
  }
  const productionUrl =
    "productionUrl" in promoted && typeof promoted.productionUrl === "string" ? promoted.productionUrl : undefined
  deployment = markDeploymentPromoted(scope.projectPath, scope.taskId, deployment.id, { productionUrl })
  emitProgress(input, emit, "promoting", "success", `Production now serves ${productionUrl ?? remote.url}.`)

  // The deployment's own URL was protected; the production domain usually is
  // not, so the checks run there now.
  if (checked.blocked && productionUrl) {
    const after = await runPostDeployChecks(
      input,
      deployment,
      settings,
      { bypass: access.bypass, protectedUrl: false, afterPromotion: true },
      productionUrl,
      options,
      emit,
    )
    deployment = after.deployment
    if (!requiredChecksPassed(deployment.checks)) {
      return {
        ...failure(
          input,
          emit,
          `Production now serves this release, and its checks failed on ${productionUrl}. Roll back to the previous production deployment if the site is broken.`,
          "checks_failed",
        ),
        url: productionUrl,
        log,
        deploymentId: deployment.id,
        providerDeploymentId: remote.id,
        environment: "production",
        productionUrl,
        checks: deployment.checks,
        protectedChecks: "checked-after-promotion",
        notes,
      }
    }
  }
  emitProgress(input, emit, "complete", "success", "Production release is live.")
  return {
    ok: true,
    target: "vercel",
    url: productionUrl ?? deployment.url,
    log,
    deploymentId: deployment.id,
    providerDeploymentId: remote.id,
    environment: "production",
    productionUrl,
    checks: deployment.checks,
    protectedChecks: checked.blocked ? (productionUrl ? "checked-after-promotion" : "skipped") : undefined,
    notes,
  }
}

function failure(
  input: PublishProjectInput,
  emit: PublishProgressEmitter | undefined,
  error: string,
  errorCode: PublishErrorCode,
): PublishResult {
  emitProgress(input, emit, "failed", "error", error)
  return { ok: false, target: "vercel", log: "", error, errorCode }
}

// The CLI prints its own wording; these are the causes a user can act on.
function classifyCliFailure(
  log: string,
  code: number | null,
  projectName: string,
): { error: string; code: PublishErrorCode } {
  if (
    /token is not valid|invalid token|not authorized|not authenticated|no existing credentials|please (?:log ?in|login)/i.test(
      log,
    )
  ) {
    return {
      error:
        "Vercel rejected Vector's saved token: it expired, was revoked or lost access. Reconnect Vercel in Cloud Services > Integrations.",
      code: "token_rejected",
    }
  }
  if (/project not found|could not find (?:the )?project|project .* (?:was )?not found/i.test(log)) {
    return {
      error: `The Vercel CLI could not find the linked project ${projectName}. Link the project again in Cloud Services > Integrations.`,
      code: "not_linked",
    }
  }
  if (/command not found|ENOENT|npm ERR! code E404|could not determine executable/i.test(log)) {
    return { error: NO_NODE, code: "no_node" }
  }
  return {
    error: `The Vercel CLI exited with code ${code ?? "unknown"} and printed no deployment URL. Read the log for its reason.`,
    code: "deploy_failed",
  }
}

export type DeploymentActionInput = {
  projectPath: string
  taskId?: string
  id: string
  runId?: string
}

function actionProgress(deployment: CloudDeployment, runId?: string): PublishProjectInput {
  return {
    projectPath: deployment.deploymentPath ?? deployment.projectPath,
    scopeProjectPath: deployment.projectPath,
    scopeTaskId: deployment.taskId,
    target: "vercel",
    runId,
  }
}

export async function rerunDeploymentChecks(
  input: DeploymentActionInput,
  options: PublishOptions = {},
): Promise<CloudDeployment> {
  const deployment = getDeployment(input.projectPath, input.taskId, input.id)
  const checked = await runPostDeployChecks(
    actionProgress(deployment, input.runId),
    deployment,
    getBuildSettings(input.projectPath, input.taskId),
    await releaseCheckAccess(input.projectPath, deployment, options),
    deployment.url,
    options,
  )
  return checked.deployment
}

// Observability's probe of one release: the release check's health probe, so
// a protected preview reads as protected rather than broken. A release whose
// project is no longer linked is probed without protection details.
export async function checkDeploymentHealth(input: DeploymentActionInput, options: PublishOptions = {}) {
  const deployment = getDeployment(input.projectPath, input.taskId, input.id)
  const health = await healthCheck(
    actionProgress(deployment, input.runId),
    deployment,
    getBuildSettings(input.projectPath, input.taskId),
    await releaseCheckAccess(input.projectPath, deployment, options).catch(() => ({ protectedUrl: false })),
    deployment.url,
    options,
  )
  return health.deployment
}

export async function checkAllDeploymentHealth(projectPath: string, taskId?: string, options: PublishOptions = {}) {
  await Promise.all(
    listDeployments(projectPath, taskId).map((item) =>
      checkDeploymentHealth({ projectPath, taskId, id: item.id }, options),
    ),
  )
  return listDeployments(projectPath, taskId)
}

async function releaseCheckAccess(
  projectPath: string,
  deployment: CloudDeployment,
  options: PublishOptions,
): Promise<CheckAccess> {
  const context = await vercelLinkContext(projectPath)
  const project = await readVercelProject(context, options.request).catch(() => undefined)
  return {
    bypass: await vercelBypassSecret(context, options.request).catch(() => undefined),
    protectedUrl: protectsDeployment(
      project?.protection,
      deployment.releaseStatus === "current" ? "production" : "preview",
    ),
  }
}
