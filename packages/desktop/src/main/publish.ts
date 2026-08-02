import { execFile, spawn } from "node:child_process"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, extname, join, relative } from "node:path"

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
import { extractDeployUrl, normalizeDeployUrl } from "./publish-url"

export { normalizeDeployUrl } from "./publish-url"

// Publish the user's app straight from the Preview panel — Lovable-style, but
// BYOK like everything else in Vector: deploys go to the USER's own Vercel or
// Netlify account through their CLI login. Vector never proxies the code.

export type PublishTargetId = "vector-cloud" | "vercel" | "netlify"

export type PublishTarget = {
  id: PublishTargetId
  label: string
  command: string[]
  loginHint: string
  available: boolean
  /** The logged-in account (e.g. Vercel/Netlify username), when detectable. */
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

const activePublishes = new Map<string, ReturnType<typeof spawn>>()
const activeVectorPublishes = new Set<string>()

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

function execOk(command: string, args: string[]) {
  return new Promise<boolean>((resolve) => {
    execFile(command, args, { timeout: 10_000 }, (error) => resolve(!error))
  })
}

// Capture stdout so we can read the logged-in account (`vercel whoami`).
// Read-only; returns undefined when the CLI is missing or not logged in.
function execOut(command: string, args: string[]) {
  return new Promise<string | undefined>((resolve) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim() || undefined),
    )
  })
}

function runProcess(input: {
  command: string
  args?: string[]
  cwd: string
  timeoutMs?: number
  shell?: boolean
  onOutput?: (output: string) => void
  env?: NodeJS.ProcessEnv
}) {
  return new Promise<{ ok: boolean; code: number | null; signal: NodeJS.Signals | null; log: string }>((resolve) => {
    const child = spawn(input.command, input.args ?? [], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env, CI: "1", FORCE_COLOR: "0" },
      shell: input.shell,
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

export async function detectPublishTargets(): Promise<PublishTarget[]> {
  const vercelConnection = cachedCloudProviderConnection("vercel")
  const netlifyConnection = cachedCloudProviderConnection("netlify")
  const [vercel, netlify, npx] = await Promise.all([
    execOk("vercel", ["--version"]),
    execOk("netlify", ["--version"]),
    execOk("npx", ["--version"]),
  ])
  // Only ask who's logged in when the CLI is actually installed.
  const [vercelAccount, netlifyAccount] = await Promise.all([
    vercel
      ? execOut("vercel", ["whoami"])
      : npx
        ? execOut("npx", ["--yes", "vercel", "whoami"])
        : Promise.resolve(undefined),
    netlify
      ? execOut("netlify", ["status"]).then((out) => out?.match(/Email:\s*(\S+)/i)?.[1])
      : Promise.resolve(undefined),
  ])
  return [
    {
      // Vector's own hosting (alpha): a token-gated static publish service.
      // Configured via env until cloud accounts exist.
      id: "vector-cloud",
      label: "Vector Cloud",
      command: [],
      loginHint: "Set VECTOR_CLOUD_URL and VECTOR_CLOUD_TOKEN to enable Vector Cloud publishing.",
      available: Boolean(process.env.VECTOR_CLOUD_URL && process.env.VECTOR_CLOUD_TOKEN),
    },
    {
      id: "vercel",
      label: vercel ? "Vercel" : "Vercel (via npx)",
      command: vercel ? ["vercel"] : ["npx", "--yes", "vercel"],
      loginHint: vercelConnection.connected
        ? "Connected through Vector Cloud."
        : "Connect Vercel in Vector Cloud, or sign in with the Vercel CLI.",
      available: (vercel || npx) && Boolean(vercelConnection.connected || vercelAccount),
      account: vercelConnection.account ?? vercelAccount,
    },
    {
      id: "netlify",
      label: netlify ? "Netlify" : "Netlify (via npx)",
      command: netlify ? ["netlify"] : ["npx", "--yes", "netlify-cli"],
      loginHint: netlifyConnection.connected
        ? "Connected through Vector Cloud."
        : "Connect Netlify in Vector Cloud, or sign in with the Netlify CLI.",
      available: (netlify || npx) && Boolean(netlifyConnection.connected || netlifyAccount),
      account: netlifyConnection.account ?? netlifyAccount,
    },
  ]
}

// Every app published from Vector carries a small floating badge linking back
// to vectordev.ai — the marker comment keeps injection idempotent.
const BADGE_MARKER = "vector-badge"
const BADGE_SNIPPET = `    <!-- ${BADGE_MARKER} -->
    <a href="https://vectordev.ai" target="_blank" rel="noopener" style="position:fixed;right:14px;bottom:14px;z-index:2147483647;display:flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;background:rgba(16,15,19,0.92);color:#f5f3ff;font:600 12px/1 Inter,system-ui,sans-serif;text-decoration:none;box-shadow:0 4px 24px rgba(0,0,0,0.35);border:1px solid rgba(147,116,236,0.4)">
      <span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:linear-gradient(135deg,#f0a36e,#ec7fae,#9374ec,#6ba6dd)"></span>
      Deployed with Vector
    </a>
`

async function injectVectorBadge(directory: string) {
  for (const candidate of ["index.html", join("public", "index.html")]) {
    const path = join(directory, candidate)
    const html = await readFile(path, "utf8").catch(() => undefined)
    if (html === undefined) continue
    if (html.includes(BADGE_MARKER)) return "present"
    if (!/<\/body>/i.test(html)) continue
    await writeFile(path, html.replace(/<\/body>/i, `${BADGE_SNIPPET}  </body>`), "utf8")
    return "injected"
  }
  // Framework apps without a plain index.html (e.g. Next.js) skip the badge
  // rather than guessing at build internals.
  return "skipped"
}

function parsePublishResponse(value: unknown) {
  if (!value || typeof value !== "object") return {}
  const string = (key: string) => {
    const item = Reflect.get(value, key)
    return typeof item === "string" ? item : undefined
  }
  return {
    ok: Reflect.get(value, "ok") === true,
    url: normalizeDeployUrl(string("url")),
    slug: string("slug"),
    error: string("error"),
  }
}

const TEXT_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".svg",
  ".txt",
  ".md",
  ".map",
  ".xml",
  ".webmanifest",
])
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", ".vercel", ".netlify", "dist", ".next", ".turbo"])

// Collect a static bundle for Vector Cloud: prefer a built dist/ (or build/)
// with an index.html, otherwise the project root for plain static apps.
async function collectStaticFiles(projectPath: string, configuredOutput?: string) {
  let root = projectPath
  if (configuredOutput && configuredOutput !== ".") {
    const configuredRoot = join(projectPath, configuredOutput)
    if (!(await stat(join(configuredRoot, "index.html")).catch(() => undefined))) {
      throw new Error(
        `The configured output directory "${configuredOutput}" does not contain index.html. Run the build or update Build & runtime settings.`,
      )
    }
    root = configuredRoot
  } else {
    for (const candidate of ["dist", "build", "out"]) {
      if (await stat(join(projectPath, candidate, "index.html")).catch(() => undefined)) {
        root = join(projectPath, candidate)
        break
      }
    }
  }
  const files: { path: string; content: string; encoding: "utf8" | "base64" }[] = []
  let total = 0
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (files.length >= 200) return
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (root === projectPath && SKIP_DIRECTORIES.has(entry.name)) continue
        if (entry.name.startsWith(".")) continue
        await walk(full)
        continue
      }
      if (!entry.isFile() || entry.name === ".DS_Store" || entry.name.startsWith(".env")) continue
      const buffer = await readFile(full)
      total += buffer.byteLength
      if (total > 10 * 1024 * 1024)
        throw new Error("This app is over Vector Cloud's 10 MB alpha limit. Publish the built output instead.")
      const utf8 = TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())
      files.push({
        path: relative(root, full).split("\\").join("/"),
        content: buffer.toString(utf8 ? "utf8" : "base64"),
        encoding: utf8 ? "utf8" : "base64",
      })
    }
  }
  await walk(root)
  if (!files.some((file) => file.path === "index.html")) {
    throw new Error("Vector Cloud needs an index.html at the app root (or in dist/) — build the app first.")
  }
  return files
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
  const findings = await scanProjectSecrets(input.projectPath)
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

async function publishToVectorCloud(input: PublishProjectInput, emit?: PublishProgressEmitter): Promise<PublishResult> {
  const endpoint = process.env.VECTOR_CLOUD_URL?.replace(/\/$/, "")
  const token = process.env.VECTOR_CLOUD_TOKEN
  if (!endpoint || !token) {
    return { ok: false, target: "vector-cloud", log: "", error: "Vector Cloud is not configured on this machine." }
  }
  const directory = input.projectPath
  if (!directory || !(await stat(directory).catch(() => undefined))?.isDirectory()) {
    return { ok: false, target: "vector-cloud", log: "", error: "Open a project before publishing." }
  }
  const scope = scopeFor(input)
  const startedAt = Date.now()
  const settings = getBuildSettings(scope.projectPath, scope.taskId)
  emitProgress(
    input,
    emit,
    "preparing",
    "info",
    `Preparing ${input.workspaceName ?? basename(directory)} for Vector Cloud.`,
  )
  const preflight = await runPreflightChecks(input, settings, emit)
  const preflightLog = redactCloudLog(scope.projectPath, scope.taskId, preflight.log).slice(-40_000)
  if (!preflight.ok) {
    emitProgress(input, emit, "failed", "error", "Required pre-deploy checks failed.")
    return {
      ok: false,
      target: "vector-cloud",
      log: preflightLog,
      checks: preflight.checks,
      error: "Required pre-deploy checks failed. Review the evidence, repair the project, and publish again.",
    }
  }

  await injectVectorBadge(directory).catch(() => "skipped")
  const files = await collectStaticFiles(directory, settings?.outputDirectory)
  emitProgress(input, emit, "uploading", "info", `Uploading ${files.length} files to Vector Cloud.`)
  const response = await fetch(`${endpoint}/api/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: input.workspaceName ?? (basename(scope.projectPath) || "app"),
      project: basename(scope.projectPath) || "app",
      environment: "preview",
      files,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  const body = parsePublishResponse(await response.json().catch(() => undefined))
  if (!response.ok || !body.ok || !body.url) {
    const error = body.error ?? `Vector Cloud responded with ${response.status}.`
    emitProgress(input, emit, "failed", "error", error)
    return { ok: false, target: "vector-cloud", log: preflightLog, checks: preflight.checks, error }
  }

  const log = redactCloudLog(
    scope.projectPath,
    scope.taskId,
    [preflightLog.trim(), `Published ${files.length} files to Vector Cloud.`].filter(Boolean).join("\n"),
  )
  let deployment = recordDeployment({
    slug: body.slug ?? body.url.match(/\/s\/([^/]+)/)?.[1] ?? body.url,
    url: body.url,
    name: input.workspaceName ?? (basename(scope.projectPath) || "app"),
    projectPath: scope.projectPath,
    taskId: scope.taskId,
    deploymentPath: directory,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    target: "vector-cloud",
    environment: "preview",
    log,
    durationMs: Date.now() - startedAt,
    checks: preflight.checks,
    git: await readGitMetadata(directory),
  })
  emitProgress(input, emit, "uploading", "success", `Preview deployed at ${body.url}`)
  deployment = await runPostDeployChecks(input, deployment, settings, emit)
  if (!requiredChecksPassed(deployment.checks)) {
    const error = "The preview deployed, but required release checks failed. Production was not changed."
    emitProgress(input, emit, "failed", "error", error)
    return {
      ok: false,
      target: "vector-cloud",
      url: deployment.url,
      log,
      deploymentId: deployment.id,
      checks: deployment.checks,
      error,
    }
  }
  if (input.production !== false) {
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
    input.production === false ? "Preview is ready." : "Production release is live.",
  )
  return {
    ok: true,
    target: "vector-cloud",
    url: deployment.productionUrl ?? deployment.url,
    log,
    deploymentId: deployment.id,
    checks: deployment.checks,
  }
}

export async function publishProject(
  input: PublishProjectInput,
  emit?: PublishProgressEmitter,
): Promise<PublishResult> {
  const scope = scopeFor(input)
  const publishKey = `${input.projectPath}:${input.target}`
  if (input.target === "vector-cloud") {
    if (activeVectorPublishes.has(publishKey)) {
      return { ok: false, target: input.target, log: "", error: "A publish is already running for this project." }
    }
    activeVectorPublishes.add(publishKey)
    return publishToVectorCloud(input, emit).finally(() => activeVectorPublishes.delete(publishKey))
  }
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

  const targets = await detectPublishTargets()
  const target = targets.find((item) => item.id === input.target)
  if (!target?.available) {
    return {
      ok: false,
      target: input.target,
      log: "",
      error: `${input.target} is not available on this machine. ${target?.loginHint ?? ""}`.trim(),
    }
  }
  if (target.id !== "vercel" && target.id !== "netlify") {
    return { ok: false, target: target.id, log: "", error: "Unsupported publish target." }
  }
  const providerAuth = await getCloudProviderRuntimeAuth(target.id)
  const providerLink = getCloudProviderProjectLink(scope.projectPath, scope.taskId, target.id)
  if (providerAuth.token && !providerLink) {
    return {
      ok: false,
      target: target.id,
      log: "",
      error: `Choose a ${target.label.replace(" (via npx)", "")} project in Vector Cloud before publishing.`,
    }
  }
  const providerEnv: NodeJS.ProcessEnv =
    target.id === "vercel"
      ? providerAuth.token
        ? { VERCEL_TOKEN: providerAuth.token }
        : {}
      : providerAuth.token
        ? { NETLIFY_AUTH_TOKEN: providerAuth.token }
        : {}

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

  await injectVectorBadge(directory).catch(() => "skipped")
  const directProduction = target.id === "netlify" && input.production !== false
  const destinationArgs =
    target.id === "vercel"
      ? providerLink
        ? [
            "--project",
            providerLink.projectId,
            ...(providerLink.accountId ? ["--scope", providerLink.accountId] : []),
          ]
        : []
      : providerLink
        ? ["--site", providerLink.projectId]
        : []
  const args =
    target.id === "vercel"
      ? [...target.command.slice(1), "--yes", ...destinationArgs]
      : [
          ...target.command.slice(1),
          "deploy",
          "--build",
          ...destinationArgs,
          ...(directProduction ? ["--prod"] : []),
        ]
  emitProgress(
    input,
    emit,
    "uploading",
    "info",
    directProduction
      ? `Deploying directly to ${target.label} production.`
      : `Creating an immutable ${target.label} preview.`,
  )

  const command = await new Promise<{ ok: boolean; code: number | null; signal: NodeJS.Signals | null; log: string }>(
    (resolve) => {
      const child = spawn(target.command[0], args, {
        cwd: directory,
        env: { ...process.env, ...providerEnv, CI: "1", FORCE_COLOR: "0" },
      })
      activePublishes.set(publishKey, child)
      let output = ""
      const capture = (chunk: Buffer) => {
        const text = chunk.toString()
        output = (output + text).slice(-40_000)
        const redacted = redactCloudLog(scope.projectPath, scope.taskId, text).trim()
        if (redacted) emitProgress(input, emit, "uploading", "info", redacted.slice(-800))
      }
      child.stdout?.on("data", capture)
      child.stderr?.on("data", capture)
      const timeout = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000)
      child.on("close", (code, signal) => {
        clearTimeout(timeout)
        activePublishes.delete(publishKey)
        resolve({ ok: code === 0 && !signal, code, signal, log: output })
      })
      child.on("error", (error) => {
        clearTimeout(timeout)
        activePublishes.delete(publishKey)
        resolve({ ok: false, code: null, signal: null, log: `${output}\n${error.message}` })
      })
    },
  )

  const commandLog = redactCloudLog(scope.projectPath, scope.taskId, command.log).slice(-40_000)
  const log = [preflightLog.trim(), commandLog.trim()].filter(Boolean).join("\n")
  if (command.signal) {
    emitProgress(input, emit, "failed", "error", "Publish timed out after 10 minutes.")
    return { ok: false, target: target.id, log, checks: preflight.checks, error: "Publish timed out after 10 minutes." }
  }
  const url = extractDeployUrl(command.log, target.id)
  if (!command.ok || !url) {
    const needsLogin =
      /not (?:logged|authenticated)|no existing credentials|please login|vercel login|netlify login/i.test(command.log)
    const error = needsLogin
      ? `You are not logged in to ${target.label}. ${target.loginHint} Then publish again.`
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
    environment: directProduction ? "production" : "preview",
    log,
    durationMs: Date.now() - startedAt,
    checks: preflight.checks,
    git: await readGitMetadata(directory),
  })
  emitProgress(input, emit, "uploading", "success", `Deployment available at ${url}`)
  deployment = await runPostDeployChecks(input, deployment, settings, emit)
  if (!requiredChecksPassed(deployment.checks)) {
    const error = directProduction
      ? "The production deployment completed, but required checks failed. Review the evidence and repair immediately."
      : "The preview deployed, but required release checks failed. Production was not changed."
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
  if (target.id === "vercel" && input.production !== false) {
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
    input.production === false ? "Preview is ready." : "Production release is live.",
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

async function vectorCloudPromotion(deployment: CloudDeployment) {
  const endpoint = process.env.VECTOR_CLOUD_URL?.replace(/\/$/, "")
  const token = process.env.VECTOR_CLOUD_TOKEN
  if (!endpoint || !token) throw new Error("Vector Cloud is not configured on this machine.")
  const response = await fetch(`${endpoint}/api/promote`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ project: basename(deployment.projectPath) || deployment.name, slug: deployment.slug }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = parsePublishResponse(await response.json().catch(() => undefined))
  if (!response.ok || !body.ok || !body.url) {
    throw new Error(body.error ?? `Vector Cloud promotion failed with ${response.status}.`)
  }
  return body.url
}

async function vercelDeploymentCommand(deployment: CloudDeployment, action: "promote" | "rollback") {
  const target = (await detectPublishTargets()).find((item) => item.id === "vercel")
  if (!target?.available) throw new Error(`Vercel is unavailable. ${target?.loginHint ?? ""}`.trim())
  const auth = await getCloudProviderRuntimeAuth("vercel")
  const result = await runProcess({
    command: target.command[0],
    args: [...target.command.slice(1), action, deployment.url, "--yes"],
    cwd: deployment.deploymentPath ?? deployment.projectPath,
    env: auth.token ? { VERCEL_TOKEN: auth.token } : undefined,
  })
  if (!result.ok) throw new Error(redactCloudLog(deployment.projectPath, deployment.taskId, result.log).slice(-4_000))
  return extractDeployUrl(result.log, "vercel") ?? deployment.url
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
    target: isPublishTargetId(deployment.target) ? deployment.target : "vector-cloud",
    runId: input.runId,
  }
  emitProgress(progressInput, emit, "promoting", "info", `Promoting ${deployment.url} to production.`)
  const productionUrl =
    deployment.target === "vector-cloud"
      ? await vectorCloudPromotion(deployment)
      : deployment.target === "vercel"
        ? await vercelDeploymentCommand(deployment, "promote")
        : (() => {
            throw new Error("Promotion is available for Vector Cloud and Vercel deployments.")
          })()
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
    target: isPublishTargetId(deployment.target) ? deployment.target : "vector-cloud",
    runId: input.runId,
  }
  emitProgress(progressInput, emit, "promoting", "info", `Rolling production back to ${deployment.url}.`)
  const productionUrl =
    deployment.target === "vector-cloud"
      ? await vectorCloudPromotion(deployment)
      : deployment.target === "vercel"
        ? await vercelDeploymentCommand(deployment, "rollback")
        : (() => {
            throw new Error("Rollback is available for Vector Cloud and Vercel deployments.")
          })()
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
  if (deployment.target === "vector-cloud") {
    const log = [
      deployment.log ?? "No build output was recorded.",
      ...deployment.checks.filter((check) => check.output).map((check) => `\n[${check.label}]\n${check.output}`),
    ].join("\n")
    updateDeployment(input.projectPath, input.taskId, input.id, { runtimeLog: log, runtimeLogFetchedAt: fetchedAt })
    return { log, fetchedAt, source: "build" }
  }
  if (deployment.target !== "vercel") {
    throw new Error(
      "Runtime log streaming is currently available for Vercel. Netlify deployments keep their build log in Vector.",
    )
  }
  const target = (await detectPublishTargets()).find((item) => item.id === "vercel")
  if (!target?.available) throw new Error(`Vercel is unavailable. ${target?.loginHint ?? ""}`.trim())
  const auth = await getCloudProviderRuntimeAuth("vercel")
  const result = await runProcess({
    command: target.command[0],
    args: [
      ...target.command.slice(1),
      "logs",
      "--deployment",
      deployment.url,
      "--json",
      "--limit",
      "100",
      "--since",
      "1h",
    ],
    cwd: deployment.deploymentPath ?? deployment.projectPath,
    timeoutMs: 30_000,
    env: auth.token ? { VERCEL_TOKEN: auth.token } : undefined,
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
    target: isPublishTargetId(deployment.target) ? deployment.target : "vector-cloud",
    runId: input.runId,
  }
  return runPostDeployChecks(progressInput, deployment, settings)
}

function isPublishTargetId(value: string): value is PublishTargetId {
  return value === "vector-cloud" || value === "vercel" || value === "netlify"
}
