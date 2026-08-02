import { randomUUID, createHash } from "node:crypto"
import { resolveCname } from "node:dns/promises"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join, normalize } from "node:path"

import { getStore } from "./store"
import { transitionReleaseRecords } from "./cloud-release-state"

// The Vector Cloud console is the desktop-side brain behind the full-page
// dashboard: it tracks real deployments, writes env vars into the project's
// actual .env, and wires a Supabase connection into the project. State lives
// locally in electron-store; filesystem effects land in the user's project.

const DEPLOYMENTS_STORE = "cloud-deployments"
const PROJECTS_STORE = "cloud-projects"
const STORE_KEY = "records"

const ENV_MARKER = "# --- Vector-managed (do not edit below) ---"
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const now = () => new Date().toISOString()

function cleanDeploymentUrl(value?: string) {
  const candidate = value?.match(/https?:\/\/[^\s"'`,}\]]+/i)?.[0]?.replace(/[);.]+$/, "")
  if (!candidate || !URL.canParse(candidate)) return undefined
  const parsed = new URL(candidate)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
  return parsed.toString()
}

export type CloudDeployment = {
  id: string
  slug: string
  url: string
  productionUrl?: string
  name: string
  projectPath: string
  taskId?: string
  deploymentPath?: string
  workspaceId?: string
  workspaceName?: string
  target: string
  createdAt: string
  environment: "preview" | "production"
  releaseStatus: "preview" | "current" | "superseded" | "rolled-back"
  status: "ready" | "degraded" | "unreachable" | "unknown"
  log?: string
  runtimeLog?: string
  runtimeLogFetchedAt?: string
  durationMs?: number
  promotedAt?: string
  rolledBackAt?: string
  lastCheckedAt?: string
  statusCode?: number
  latencyMs?: number
  healthError?: string
  checks: CloudDeploymentCheck[]
  git?: CloudGitMetadata
}

export type CloudEnvVar = { key: string; value: string }

export type CloudDeploymentCheck = {
  id: string
  type: "install" | "test" | "build" | "secrets" | "health" | "browser"
  label: string
  status: "pending" | "running" | "passed" | "warning" | "failed" | "skipped"
  required: boolean
  details?: string
  output?: string
  durationMs?: number
  checkedAt: string
  screenshotPath?: string
}

export type CloudGitMetadata = {
  branch: string
  commitSha: string
  commitShort: string
  commitMessage: string
  remoteUrl?: string
  dirty: boolean
}

export type CloudRequiredChecks = {
  test: boolean
  secrets: boolean
  health: boolean
  browser: boolean
}

export type CloudBuildSettings = {
  framework: string
  packageManager: "bun" | "pnpm" | "yarn" | "npm" | "static"
  installCommand: string
  testCommand: string
  buildCommand: string
  outputDirectory: string
  nodeVersion: string
  healthPath: string
  requiredChecks: CloudRequiredChecks
  source: "detected" | "custom"
  updatedAt: string
}

type PackageManifest = {
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  nodeVersion: string
}

export type CloudDomainStatus = "pending" | "verified" | "error"
export type CloudDomainProvider = "vector-cloud" | "vercel" | "netlify"

export type CloudDomain = {
  id: string
  domain: string
  projectPath?: string
  slug?: string
  provider: CloudDomainProvider
  providerProjectId?: string
  providerProjectName?: string
  cnameTarget: string
  status: CloudDomainStatus
  lastCheckedAt?: string
  detail?: string
  createdAt: string
}

export type CloudDatabaseConnection =
  | {
      provider: "supabase"
      url: string
      anonKey: string
      projectRef?: string
      projectName?: string
      managedByOAuth?: boolean
      connectedAt: string
    }
  | null

// ---- Deployments ----------------------------------------------------------

function readDeployments(): CloudDeployment[] {
  const raw = getStore(DEPLOYMENTS_STORE).get(STORE_KEY)
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (item): item is Partial<CloudDeployment> & Pick<CloudDeployment, "id" | "url"> =>
        typeof item?.id === "string" && typeof item?.url === "string",
    )
    .map((item) => ({
      id: item.id,
      slug: typeof item.slug === "string" ? item.slug : item.url,
      url: cleanDeploymentUrl(item.url) ?? item.url.trim(),
      name: typeof item.name === "string" ? item.name : "Deployment",
      projectPath: typeof item.projectPath === "string" ? item.projectPath : "",
      taskId: typeof item.taskId === "string" ? item.taskId : undefined,
      deploymentPath: typeof item.deploymentPath === "string" ? item.deploymentPath : undefined,
      workspaceId: typeof item.workspaceId === "string" ? item.workspaceId : undefined,
      workspaceName: typeof item.workspaceName === "string" ? item.workspaceName : undefined,
      target: typeof item.target === "string" ? item.target : "unknown",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : now(),
      environment: item.environment === "preview" ? "preview" : "production",
      releaseStatus:
        item.releaseStatus === "preview" ||
        item.releaseStatus === "current" ||
        item.releaseStatus === "superseded" ||
        item.releaseStatus === "rolled-back"
          ? item.releaseStatus
          : item.environment === "preview"
            ? "preview"
            : "current",
      status:
        item.status === "ready" || item.status === "degraded" || item.status === "unreachable"
          ? item.status
          : "unknown",
      productionUrl: typeof item.productionUrl === "string" ? cleanDeploymentUrl(item.productionUrl) : undefined,
      log: typeof item.log === "string" ? item.log : undefined,
      runtimeLog: typeof item.runtimeLog === "string" ? item.runtimeLog : undefined,
      runtimeLogFetchedAt: typeof item.runtimeLogFetchedAt === "string" ? item.runtimeLogFetchedAt : undefined,
      durationMs: typeof item.durationMs === "number" ? item.durationMs : undefined,
      promotedAt: typeof item.promotedAt === "string" ? item.promotedAt : undefined,
      rolledBackAt: typeof item.rolledBackAt === "string" ? item.rolledBackAt : undefined,
      lastCheckedAt: typeof item.lastCheckedAt === "string" ? item.lastCheckedAt : undefined,
      statusCode: typeof item.statusCode === "number" ? item.statusCode : undefined,
      latencyMs: typeof item.latencyMs === "number" ? item.latencyMs : undefined,
      healthError: typeof item.healthError === "string" ? item.healthError : undefined,
      checks: Array.isArray(item.checks) ? item.checks.filter(isCloudDeploymentCheck) : [],
      git: isCloudGitMetadata(item.git) ? item.git : undefined,
    }))
}

function writeDeployments(records: CloudDeployment[]) {
  getStore(DEPLOYMENTS_STORE).set(STORE_KEY, records)
}

function isCloudDeploymentCheck(value: unknown): value is CloudDeploymentCheck {
  if (!value || typeof value !== "object") return false
  return (
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "type") === "string" &&
    typeof Reflect.get(value, "label") === "string" &&
    typeof Reflect.get(value, "status") === "string" &&
    typeof Reflect.get(value, "required") === "boolean" &&
    typeof Reflect.get(value, "checkedAt") === "string"
  )
}

function isCloudGitMetadata(value: unknown): value is CloudGitMetadata {
  if (!value || typeof value !== "object") return false
  return (
    typeof Reflect.get(value, "branch") === "string" &&
    typeof Reflect.get(value, "commitSha") === "string" &&
    typeof Reflect.get(value, "commitShort") === "string" &&
    typeof Reflect.get(value, "commitMessage") === "string" &&
    typeof Reflect.get(value, "dirty") === "boolean"
  )
}

// Every successful publish is immutable history. Promotion changes which
// release is current; it never erases the artifact that was live before it.
export function recordDeployment(input: {
  slug: string
  url: string
  productionUrl?: string
  name: string
  projectPath: string
  taskId?: string
  deploymentPath?: string
  workspaceId?: string
  workspaceName?: string
  target: string
  environment?: "preview" | "production"
  log?: string
  durationMs?: number
  checks?: CloudDeploymentCheck[]
  git?: CloudGitMetadata
}): CloudDeployment {
  const records = readDeployments()
  const environment = input.environment ?? "production"
  const createdAt = now()
  const record: CloudDeployment = {
    id: randomUUID(),
    slug: input.slug,
    url: cleanDeploymentUrl(input.url) ?? input.url.trim(),
    productionUrl: cleanDeploymentUrl(input.productionUrl),
    name: input.name,
    projectPath: input.projectPath,
    taskId: input.taskId,
    deploymentPath: input.deploymentPath,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    target: input.target,
    createdAt,
    environment,
    releaseStatus: environment === "production" ? "current" : "preview",
    status: "unknown",
    log: input.log ? redactCloudLog(input.projectPath, input.taskId, input.log).slice(-40_000) : undefined,
    durationMs: input.durationMs,
    promotedAt: environment === "production" ? createdAt : undefined,
    checks: (input.checks ?? []).map((check) => ({
      ...check,
      output: check.output ? redactCloudLog(input.projectPath, input.taskId, check.output).slice(-20_000) : undefined,
    })),
    git: input.git,
  }
  const rest =
    environment === "production"
      ? records.map((item) =>
          sameDeploymentScope(item, record) && item.releaseStatus === "current"
            ? { ...item, releaseStatus: "superseded" as const }
            : item,
        )
      : records
  writeDeployments([record, ...rest])
  return record
}

function sameDeploymentScope(a: CloudDeployment, b: CloudDeployment): boolean {
  return a.projectPath === b.projectPath && a.taskId === b.taskId && a.target === b.target
}

export function listDeployments(projectPath: string, taskId?: string): CloudDeployment[] {
  return readDeployments().filter((record) => record.projectPath === projectPath && record.taskId === taskId)
}

export function getDeployment(projectPath: string, taskId: string | undefined, id: string): CloudDeployment {
  const deployment = readDeployments().find(
    (item) => item.id === id && item.projectPath === projectPath && item.taskId === taskId,
  )
  if (!deployment) throw new Error("That deployment is no longer in this project's history.")
  return deployment
}

export function updateDeployment(
  projectPath: string,
  taskId: string | undefined,
  id: string,
  update: Partial<CloudDeployment>,
): CloudDeployment {
  const records = readDeployments()
  const deployment = records.find(
    (item) => item.id === id && item.projectPath === projectPath && item.taskId === taskId,
  )
  if (!deployment) throw new Error("That deployment is no longer in this project's history.")
  const next = { ...deployment, ...update, id: deployment.id, projectPath, taskId }
  writeDeployments(records.map((item) => (item.id === id ? next : item)))
  return next
}

export function markDeploymentPromoted(
  projectPath: string,
  taskId: string | undefined,
  id: string,
  input: { productionUrl?: string; rollback?: boolean } = {},
): CloudDeployment {
  const records = readDeployments()
  const selected = records.find((item) => item.id === id && item.projectPath === projectPath && item.taskId === taskId)
  if (!selected) throw new Error("That deployment is no longer in this project's history.")
  const promotedAt = now()
  const updated = transitionReleaseRecords(records, selected.id, {
    productionUrl: input.productionUrl,
    rollback: Boolean(input.rollback),
    at: promotedAt,
  })
  writeDeployments(updated)
  return updated.find((item) => item.id === selected.id)!
}

export function removeDeployment(projectPath: string, taskId: string | undefined, id: string): CloudDeployment[] {
  const records = readDeployments()
  const removed = records.find((item) => item.id === id && item.projectPath === projectPath && item.taskId === taskId)
  if (removed?.releaseStatus === "current") {
    throw new Error("Promote or roll back to another release before removing the live production deployment.")
  }
  const next = removed ? records.filter((item) => item.id !== id) : records
  writeDeployments(next)
  // Best-effort delete on the remote publish service, if configured. The
  // endpoint is built by another agent, so tolerate its absence entirely.
  const endpoint = process.env.VECTOR_CLOUD_URL?.replace(/\/$/, "")
  const token = process.env.VECTOR_CLOUD_TOKEN
  if (removed?.target === "vector-cloud" && endpoint && token) {
    void fetch(`${endpoint}/api/deployments?slug=${encodeURIComponent(removed.slug)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined)
  }
  return next.filter((record) => record.projectPath === projectPath && record.taskId === taskId)
}

export async function checkDeployment(
  projectPath: string,
  taskId: string | undefined,
  id: string,
): Promise<CloudDeployment> {
  const records = readDeployments()
  const deployment = records.find(
    (item) => item.id === id && item.projectPath === projectPath && item.taskId === taskId,
  )
  if (!deployment) throw new Error("That deployment is no longer in this project's history.")

  const startedAt = Date.now()
  const checkedAt = now()
  const settings = getBuildSettings(projectPath, taskId)
  const healthUrl = new URL(settings?.healthPath ?? "/", deployment.url).toString()
  const probe = await fetch(healthUrl, {
    method: "GET",
    redirect: "follow",
    headers: { "user-agent": "Vector-Cloud-Health/1.0" },
    signal: AbortSignal.timeout(12_000),
  })
    .then(async (response) => {
      await response.body?.cancel().catch(() => undefined)
      return {
        status: response.ok ? ("ready" as const) : ("degraded" as const),
        statusCode: response.status,
        healthError: response.ok ? undefined : `HTTP ${response.status} ${response.statusText}`.trim(),
      }
    })
    .catch((error) => ({
      status: "unreachable" as const,
      statusCode: undefined,
      healthError: error instanceof Error ? error.message : String(error),
    }))

  const updated: CloudDeployment = {
    ...deployment,
    ...probe,
    lastCheckedAt: checkedAt,
    latencyMs: Date.now() - startedAt,
    checks: upsertDeploymentCheck(deployment.checks, {
      id: "health",
      type: "health",
      label: `Health check ${settings?.healthPath ?? "/"}`,
      status: probe.status === "ready" ? "passed" : "failed",
      required: settings?.requiredChecks.health ?? true,
      details:
        probe.status === "ready" ? `HTTP ${probe.statusCode} in ${Date.now() - startedAt} ms` : probe.healthError,
      durationMs: Date.now() - startedAt,
      checkedAt,
    }),
  }
  writeDeployments(records.map((item) => (item.id === updated.id ? updated : item)))
  return updated
}

export function upsertDeploymentCheck(
  checks: CloudDeploymentCheck[],
  check: CloudDeploymentCheck,
): CloudDeploymentCheck[] {
  return [...checks.filter((item) => item.id !== check.id), check]
}

export async function checkAllDeployments(projectPath: string, taskId?: string): Promise<CloudDeployment[]> {
  const deployments = listDeployments(projectPath, taskId)
  await Promise.all(deployments.map((item) => checkDeployment(projectPath, taskId, item.id)))
  return listDeployments(projectPath, taskId)
}

// ---- Per-project data (env vars + database) -------------------------------

type ProjectData = {
  env: CloudEnvVar[]
  database: CloudDatabaseConnection
  domains: CloudDomain[]
  build: CloudBuildSettings | null
}

function projectKey(projectPath: string, taskId?: string): string {
  return createHash("sha256")
    .update(`${projectPath}\n${taskId || "project"}`)
    .digest("hex")
    .slice(0, 32)
}

function readProject(projectPath: string, taskId?: string): ProjectData {
  const raw = getStore(PROJECTS_STORE).get(projectKey(projectPath, taskId))
  if (!raw || typeof raw !== "object") return { env: [], database: null, domains: [], build: null }
  const data = raw as Partial<ProjectData>
  const env = Array.isArray(data.env)
    ? data.env.filter((item): item is CloudEnvVar => typeof item?.key === "string" && typeof item?.value === "string")
    : []
  const database =
    data.database && typeof data.database === "object" && data.database.provider === "supabase" ? data.database : null
  const domains = Array.isArray(data.domains)
    ? data.domains
        .filter(
          (item): item is CloudDomain => typeof item?.id === "string" && typeof item?.domain === "string",
        )
        .map((item) => ({
          ...item,
          provider:
            item.provider === "vercel" || item.provider === "netlify" ? item.provider : ("vector-cloud" as const),
        }))
    : []
  const build =
    data.build &&
    typeof data.build === "object" &&
    typeof data.build.framework === "string" &&
    typeof data.build.buildCommand === "string" &&
    typeof data.build.outputDirectory === "string"
      ? {
          ...data.build,
          testCommand: typeof data.build.testCommand === "string" ? data.build.testCommand : "",
          healthPath: typeof data.build.healthPath === "string" ? data.build.healthPath : "/",
          requiredChecks: isCloudRequiredChecks(data.build.requiredChecks)
            ? data.build.requiredChecks
            : defaultRequiredChecks(),
        }
      : null
  return { env, database, domains, build }
}

function defaultRequiredChecks(): CloudRequiredChecks {
  return { test: false, secrets: true, health: true, browser: true }
}

function isCloudRequiredChecks(value: unknown): value is CloudRequiredChecks {
  if (!value || typeof value !== "object") return false
  return (
    typeof Reflect.get(value, "test") === "boolean" &&
    typeof Reflect.get(value, "secrets") === "boolean" &&
    typeof Reflect.get(value, "health") === "boolean" &&
    typeof Reflect.get(value, "browser") === "boolean"
  )
}

function writeProject(projectPath: string, taskId: string | undefined, data: ProjectData) {
  getStore(PROJECTS_STORE).set(projectKey(projectPath, taskId), data)
}

export function redactCloudLog(projectPath: string, taskId: string | undefined, value: string): string {
  return readProject(projectPath, taskId).env.reduce(
    (output, item) => (item.value.length >= 4 ? output.split(item.value).join("[redacted]") : output),
    value,
  )
}

// ---- Build and runtime -----------------------------------------------------

export function getBuildSettings(projectPath: string, taskId?: string): CloudBuildSettings | null {
  if (!(projectPath ?? "").trim()) return null
  return readProject(projectPath, taskId).build
}

export async function detectBuildSettings(projectPath: string, taskId?: string): Promise<CloudBuildSettings> {
  const stats = projectPath ? await stat(projectPath).catch(() => undefined) : undefined
  if (!stats?.isDirectory()) throw new Error("Open a project folder before detecting its build settings.")

  const packageJson = await readFile(join(projectPath, "package.json"), "utf8")
    .then(parsePackageManifest)
    .catch(() => undefined)

  const packageManager = await detectPackageManager(projectPath, Boolean(packageJson))
  const hasNpmLock = Boolean(await stat(join(projectPath, "package-lock.json")).catch(() => undefined))
  const dependencies = { ...packageJson?.dependencies, ...packageJson?.devDependencies }
  const framework =
    "next" in dependencies
      ? "Next.js"
      : "nuxt" in dependencies
        ? "Nuxt"
        : "@sveltejs/kit" in dependencies
          ? "SvelteKit"
          : "astro" in dependencies
            ? "Astro"
            : "@remix-run/react" in dependencies
              ? "Remix"
              : "vite" in dependencies
                ? "Vite"
                : "react-scripts" in dependencies
                  ? "Create React App"
                  : packageJson
                    ? "Node.js"
                    : "Static"
  const outputDirectory =
    framework === "Next.js"
      ? "out"
      : framework === "Nuxt"
        ? ".output/public"
        : framework === "SvelteKit"
          ? "build"
          : framework === "Astro" || framework === "Vite"
            ? "dist"
            : framework === "Create React App"
              ? "build"
              : "."
  const runBuild =
    packageManager === "bun"
      ? "bun run build"
      : packageManager === "pnpm"
        ? "pnpm run build"
        : packageManager === "yarn"
          ? "yarn build"
          : packageManager === "npm"
            ? "npm run build"
            : ""
  const installCommand =
    packageManager === "bun"
      ? "bun install"
      : packageManager === "pnpm"
        ? "pnpm install --frozen-lockfile"
        : packageManager === "yarn"
          ? "yarn install --immutable"
          : packageManager === "npm"
            ? hasNpmLock
              ? "npm ci"
              : "npm install"
            : ""
  const settings: CloudBuildSettings = {
    framework,
    packageManager,
    installCommand,
    testCommand: packageJson?.scripts.test
      ? packageManager === "bun"
        ? "bun run test"
        : packageManager === "pnpm"
          ? "pnpm run test"
          : packageManager === "yarn"
            ? "yarn test"
            : "npm test"
      : "",
    buildCommand: packageJson?.scripts.build ? runBuild : "",
    outputDirectory,
    nodeVersion: packageJson?.nodeVersion ?? "",
    healthPath: "/",
    requiredChecks: {
      ...defaultRequiredChecks(),
      test: Boolean(packageJson?.scripts.test),
    },
    source: "detected",
    updatedAt: now(),
  }
  const data = readProject(projectPath, taskId)
  writeProject(projectPath, taskId, { ...data, build: settings })
  return settings
}

function parsePackageManifest(text: string): PackageManifest {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== "object") throw new Error("package.json must contain an object.")
  const strings = (value: unknown) =>
    value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : {}
  const engines = Reflect.get(parsed, "engines")
  return {
    scripts: strings(Reflect.get(parsed, "scripts")),
    dependencies: strings(Reflect.get(parsed, "dependencies")),
    devDependencies: strings(Reflect.get(parsed, "devDependencies")),
    nodeVersion:
      engines && typeof engines === "object" && typeof Reflect.get(engines, "node") === "string"
        ? Reflect.get(engines, "node")
        : "",
  }
}

async function detectPackageManager(
  projectPath: string,
  hasPackageJson: boolean,
): Promise<CloudBuildSettings["packageManager"]> {
  if (await stat(join(projectPath, "bun.lock")).catch(() => undefined)) return "bun"
  if (await stat(join(projectPath, "bun.lockb")).catch(() => undefined)) return "bun"
  if (await stat(join(projectPath, "pnpm-lock.yaml")).catch(() => undefined)) return "pnpm"
  if (await stat(join(projectPath, "yarn.lock")).catch(() => undefined)) return "yarn"
  if (hasPackageJson) return "npm"
  return "static"
}

export function setBuildSettings(
  projectPath: string,
  taskId: string | undefined,
  input: Omit<CloudBuildSettings, "source" | "updatedAt">,
): CloudBuildSettings {
  const path = requireProject(projectPath)
  if (!["bun", "pnpm", "yarn", "npm", "static"].includes(input.packageManager)) {
    throw new Error("Choose a supported package manager.")
  }
  const outputDirectory = normalize((input.outputDirectory ?? "").trim() || ".")
  if (
    isAbsolute(outputDirectory) ||
    outputDirectory === ".." ||
    outputDirectory.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error("The output directory must stay inside the current project.")
  }
  const settings: CloudBuildSettings = {
    framework: (input.framework ?? "").trim() || "Other",
    packageManager: input.packageManager,
    installCommand: (input.installCommand ?? "").trim(),
    testCommand: (input.testCommand ?? "").trim(),
    buildCommand: (input.buildCommand ?? "").trim(),
    outputDirectory,
    nodeVersion: (input.nodeVersion ?? "").trim(),
    healthPath: normalizeHealthPath(input.healthPath),
    requiredChecks: isCloudRequiredChecks(input.requiredChecks) ? input.requiredChecks : defaultRequiredChecks(),
    source: "custom",
    updatedAt: now(),
  }
  const data = readProject(path, taskId)
  writeProject(path, taskId, { ...data, build: settings })
  return settings
}

function normalizeHealthPath(value: string): string {
  const path = (value ?? "").trim() || "/"
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new Error("Health checks use a path such as / or /api/health, not a full URL.")
  }
  return path.startsWith("/") ? path : `/${path}`
}

// ---- Environment variables ------------------------------------------------

export function listEnv(projectPath: string, taskId?: string): CloudEnvVar[] {
  return readProject(projectPath, taskId).env
}

export function setEnv(projectPath: string, taskId: string | undefined, key: string, value: string): CloudEnvVar[] {
  const trimmedKey = (key ?? "").trim()
  if (!KEY_PATTERN.test(trimmedKey)) {
    throw new Error(
      `"${trimmedKey}" is not a valid environment variable name. Use letters, digits and underscores, starting with a letter or underscore.`,
    )
  }
  const data = readProject(projectPath, taskId)
  const existing = data.env.find((item) => item.key === trimmedKey)
  const nextEnv = existing
    ? data.env.map((item) => (item.key === trimmedKey ? { key: trimmedKey, value } : item))
    : [...data.env, { key: trimmedKey, value }]
  writeProject(projectPath, taskId, { ...data, env: nextEnv })
  return nextEnv
}

export function removeEnv(projectPath: string, taskId: string | undefined, key: string): CloudEnvVar[] {
  const data = readProject(projectPath, taskId)
  const nextEnv = data.env.filter((item) => item.key !== key)
  writeProject(projectPath, taskId, { ...data, env: nextEnv })
  return nextEnv
}

// The real payoff: flush the stored vars into the project's actual .env. Any
// lines the user wrote above the Vector marker are preserved; the managed block
// below the marker is rewritten from scratch.
export async function applyEnv(projectPath: string, taskId?: string): Promise<{ written: string }> {
  const stats = projectPath ? await stat(projectPath).catch(() => undefined) : undefined
  if (!stats?.isDirectory()) {
    throw new Error("Open a project folder before applying environment variables.")
  }
  const vars = readProject(projectPath, taskId).env
  for (const item of vars) {
    if (/[\r\n]/.test(item.value)) {
      throw new Error(`The value for "${item.key}" contains a line break, which cannot be written to .env.`)
    }
  }
  const envPath = join(projectPath, ".env")
  const existing = await readFile(envPath, "utf8").catch(() => "")
  const markerIndex = existing.indexOf(ENV_MARKER)
  const preamble = (markerIndex >= 0 ? existing.slice(0, markerIndex) : existing).replace(/\s+$/, "")
  const managed = [ENV_MARKER, ...vars.map((item) => `${item.key}=${formatEnvValue(item.value)}`)].join("\n")
  const output = preamble ? `${preamble}\n\n${managed}\n` : `${managed}\n`
  await writeFile(envPath, output, "utf8")
  return { written: ".env" }
}

function formatEnvValue(value: string) {
  if (value === "") return '""'
  if (!/[\s#'"\\]/.test(value)) return value
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

// ---- Custom domains -------------------------------------------------------

// The CNAME target apps should point at. Configurable for staging/self-host.
function cnameTarget(): string {
  return process.env.VECTOR_CLOUD_DOMAIN_TARGET || "cname.vectordev.app"
}

// Lowercase, strip protocol/path/trailing slash, drop a leading "www.", and
// require something that looks like a real hostname with at least one dot.
export function normalizeCloudDomain(raw: string): string {
  let domain = (raw ?? "").trim().toLowerCase()
  domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  domain = domain.replace(/[/?#].*$/, "")
  domain = domain.replace(/\.+$/, "")
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new Error(`"${raw}" doesn't look like a valid domain (for example: app.example.com).`)
  }
  return domain
}

function requireProject(projectPath: string): string {
  const path = (projectPath ?? "").trim()
  if (!path) throw new Error("Open a project before managing its domains.")
  return path
}

// Domains are scoped to a project (a Vector task's workspace), so each app
// manages its own custom domains instead of a single global pool.
export function listDomains(projectPath: string, taskId?: string): CloudDomain[] {
  if (!(projectPath ?? "").trim()) return []
  return readProject(projectPath, taskId).domains
}

export function addDomain(
  projectPath: string,
  taskId: string | undefined,
  input: {
    domain: string
    slug?: string
    provider?: CloudDomainProvider
    providerProjectId?: string
    providerProjectName?: string
    cnameTarget?: string
    status?: CloudDomainStatus
    detail?: string
  },
): CloudDomain {
  const path = requireProject(projectPath)
  const domain = normalizeCloudDomain(input.domain)
  const data = readProject(path, taskId)
  if (data.domains.find((item) => item.domain === domain)) {
    throw new Error(`${domain} is already connected to this project.`)
  }
  const record: CloudDomain = {
    id: randomUUID(),
    domain,
    projectPath: path,
    slug: input.slug?.trim() || undefined,
    provider: input.provider ?? "vector-cloud",
    providerProjectId: input.providerProjectId?.trim() || undefined,
    providerProjectName: input.providerProjectName?.trim() || undefined,
    cnameTarget: input.cnameTarget?.trim() || cnameTarget(),
    status: input.status ?? "pending",
    detail: input.detail?.trim() || undefined,
    createdAt: now(),
  }
  writeProject(path, taskId, { ...data, domains: [record, ...data.domains] })
  return record
}

export function updateDomainRecord(
  projectPath: string,
  taskId: string | undefined,
  id: string,
  patch: Partial<Omit<CloudDomain, "id" | "domain" | "projectPath" | "createdAt">>,
): CloudDomain {
  const path = requireProject(projectPath)
  const data = readProject(path, taskId)
  const index = data.domains.findIndex((item) => item.id === id)
  if (index === -1) throw new Error("That domain is no longer connected to this project.")
  const updated = { ...data.domains[index], ...patch }
  const domains = [...data.domains]
  domains[index] = updated
  writeProject(path, taskId, { ...data, domains })
  return updated
}

// Real DNS check: resolve the domain's CNAME records and see whether any point
// at our target. DNS propagation lag looks like a missing record, not an error.
export async function verifyDomain(projectPath: string, taskId: string | undefined, id: string): Promise<CloudDomain> {
  const path = requireProject(projectPath)
  const data = readProject(path, taskId)
  const index = data.domains.findIndex((item) => item.id === id)
  if (index === -1) throw new Error("That domain is no longer connected to this project.")
  const record = data.domains[index]
  const target = record.cnameTarget.toLowerCase().replace(/\.+$/, "")

  let status: CloudDomainStatus = record.status
  let detail: string | undefined

  try {
    const cnames = await resolveCname(record.domain)
    const matched = cnames.some((entry) => {
      const value = entry.toLowerCase().replace(/\.+$/, "")
      return value === target || value.endsWith(target)
    })
    if (matched) {
      status = "verified"
      detail = undefined
    } else {
      status = "pending"
      detail = "CNAME not found yet — DNS can take a few minutes."
    }
  } catch (error) {
    const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined
    if (code === "ENOTFOUND" || code === "ENODATA") {
      status = "pending"
      detail = `No CNAME record found for ${record.domain} yet. Add a CNAME pointing at ${target}, then re-check — DNS can take a few minutes.`
    } else {
      status = "error"
      detail = error instanceof Error ? error.message : String(error)
    }
  }

  const next: CloudDomain = { ...record, status, detail, lastCheckedAt: now() }
  const domains = [...data.domains]
  domains[index] = next
  writeProject(path, taskId, { ...data, domains })
  return next
}

export function removeDomain(projectPath: string, taskId: string | undefined, id: string): CloudDomain[] {
  const path = requireProject(projectPath)
  const data = readProject(path, taskId)
  const domains = data.domains.filter((item) => item.id !== id)
  writeProject(path, taskId, { ...data, domains })
  return domains
}

// ---- Database connector (Supabase) ----------------------------------------

export function getDatabase(projectPath: string, taskId?: string): CloudDatabaseConnection {
  return readProject(projectPath, taskId).database
}

const SUPABASE_CLIENT_SNIPPET = `import { createClient } from "@supabase/supabase-js"

// Vector-managed Supabase client. Values come from your project's env — set via
// the Vector Cloud console (Database + Environment Variables), written to .env.
const supabaseUrl =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_SUPABASE_URL) ||
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.SUPABASE_URL) ||
  (typeof process !== "undefined" && process.env && process.env.SUPABASE_URL)

const supabaseAnonKey =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_SUPABASE_ANON_KEY) ||
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.SUPABASE_ANON_KEY) ||
  (typeof process !== "undefined" && process.env && process.env.SUPABASE_ANON_KEY)

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
`

export async function connectDatabase(
  projectPath: string,
  taskId: string | undefined,
  input: {
    provider: "supabase"
    url: string
    anonKey: string
    projectRef?: string
    projectName?: string
    managedByOAuth?: boolean
  },
): Promise<CloudDatabaseConnection> {
  const url = (input.url ?? "").trim()
  let host = ""
  try {
    const parsed = new URL(url)
    host = parsed.hostname
    if (parsed.protocol !== "https:" || !host) throw new Error("bad")
  } catch {
    throw new Error("Enter your Supabase project URL, e.g. https://your-project.supabase.co")
  }
  const anonKey = (input.anonKey ?? "").trim()
  if (!anonKey) throw new Error("Enter your Supabase anon (public) key.")

  const connection: CloudDatabaseConnection = {
    provider: "supabase",
    url,
    anonKey,
    projectRef: input.projectRef?.trim() || undefined,
    projectName: input.projectName?.trim() || undefined,
    managedByOAuth: input.managedByOAuth === true,
    connectedAt: now(),
  }

  // Merge the credentials into the project's managed env vars so a later
  // applyEnv writes them to .env alongside everything else.
  setEnv(projectPath, taskId, "SUPABASE_URL", url)
  setEnv(projectPath, taskId, "SUPABASE_ANON_KEY", anonKey)

  const data = readProject(projectPath, taskId)
  writeProject(projectPath, taskId, { ...data, database: connection })

  // Scaffold a minimal client so `import { supabase }` just works. Never
  // clobber an existing file, and don't fail the connection if src/ is locked.
  try {
    const libDir = join(projectPath, "src", "lib")
    const clientPath = join(libDir, "supabase.js")
    const alreadyExists = await stat(clientPath).catch(() => undefined)
    if (!alreadyExists) {
      await mkdir(libDir, { recursive: true })
      await writeFile(clientPath, SUPABASE_CLIENT_SNIPPET, "utf8")
    }
  } catch {
    // Best-effort scaffold; the stored connection + env vars are the real payoff.
  }

  await applyEnv(projectPath, taskId)

  return connection
}

export function disconnectDatabase(projectPath: string, taskId?: string): void {
  const data = readProject(projectPath, taskId)
  writeProject(projectPath, taskId, { ...data, database: null })
}
