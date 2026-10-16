import { randomUUID, createHash } from "node:crypto"
import { chmodSync, constants } from "node:fs"
import { lstat, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join, normalize } from "node:path"

import { getStore } from "./store"
import { transitionReleaseRecords } from "./cloud-release-state"
import { redactText } from "./security-redaction"
import { isSupabasePublicKey } from "./cloud-public-key"
import { decryptCloudCredential, encryptCloudCredential } from "./cloud-credential-vault"
import {
  ensureEnvIgnored,
  envTracked,
  projectRefFromUrl,
  scaffoldSupabaseClient,
  supabaseFramework,
  supabasePublicEnvNames,
} from "./cloud-supabase-env"

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
  /** How the last health probe ended; "protected" means Deployment Protection kept Vector out. */
  probe?: "ok" | "failed" | "protected"
  checks: CloudDeploymentCheck[]
  git?: CloudGitMetadata
  /** Vercel's own id (dpl_...) for this release. */
  providerDeploymentId?: string
  /** The stable per-branch preview address of an agent workspace's release. */
  alias?: string
}

// "public" values may reach browser code; "server" values must not, so they can
// never use a name that a bundler inlines into the client.
export type CloudEnvVisibility = "public" | "server"
export type CloudEnvVar = { key: string; value: string; visibility: CloudEnvVisibility }

// At rest a value is encrypted with the same vault as provider tokens.
type StoredEnvVar = { key: string; secret: string; visibility: CloudEnvVisibility }

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

export type CloudDatabaseConnection = {
  provider: "supabase"
  url: string
  anonKey: string
  projectRef?: string
  projectName?: string
  managedByOAuth?: boolean
  connectedAt: string
} | null

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
      probe: item.probe === "ok" || item.probe === "failed" || item.probe === "protected" ? item.probe : undefined,
      checks: Array.isArray(item.checks) ? item.checks.filter(isCloudDeploymentCheck) : [],
      git: isCloudGitMetadata(item.git) ? item.git : undefined,
      providerDeploymentId: typeof item.providerDeploymentId === "string" ? item.providerDeploymentId : undefined,
      alias: typeof item.alias === "string" ? cleanDeploymentUrl(item.alias) : undefined,
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
  providerDeploymentId?: string
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
    providerDeploymentId: input.providerDeploymentId,
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

// A deployment belongs to the project it shipped, not to the chat session that
// happened to trigger it. `taskId` is kept on the record for provenance but is
// deliberately not part of the scope: the console renders with no taskId while
// the vector_cloud tool passes its session id, and matching on it hid every
// agent-made release from the UI that promotes and rolls releases back.
function sameDeploymentScope(a: CloudDeployment, b: CloudDeployment): boolean {
  return a.projectPath === b.projectPath && a.target === b.target
}

// Vercel is the only hosting provider. Releases an older version recorded for a
// retired host (Netlify, or the scrapped hosted publish service) stay in the
// store untouched but are not listed, promoted or rolled back.
function supportedDeployment(record: CloudDeployment): boolean {
  return record.target === "vercel"
}

export function listDeployments(projectPath: string, taskId?: string): CloudDeployment[] {
  return readDeployments().filter((record) => record.projectPath === projectPath && supportedDeployment(record))
}

export function getDeployment(projectPath: string, taskId: string | undefined, id: string): CloudDeployment {
  const deployment = readDeployments().find(
    (item) => item.id === id && item.projectPath === projectPath && supportedDeployment(item),
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
  const deployment = records.find((item) => item.id === id && item.projectPath === projectPath)
  if (!deployment) throw new Error("That deployment is no longer in this project's history.")
  const next = { ...deployment, ...update, id: deployment.id, projectPath }
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
  const selected = records.find((item) => item.id === id && item.projectPath === projectPath)
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

// The release Vector recorded for a Vercel deployment, when Vector made it:
// matched by Vercel's id, or by address for releases recorded before the id was.
export function releaseForProviderDeployment(projectPath: string, deployment: { id: string; url: string }) {
  const host = (value: string) => (URL.canParse(value) ? new URL(value).host : value)
  return listDeployments(projectPath).find(
    (item) => item.providerDeploymentId === deployment.id || host(item.url) === host(deployment.url),
  )
}

// Production moved on Vercel (a promote or rollback from Vector Cloud or the
// agent). Vector's release for that deployment becomes current; the release
// that was current is superseded or rolled back, even when Vercel now serves a
// deployment Vector did not make.
export function recordProductionMove(
  projectPath: string,
  deployment: { id: string; url: string },
  input: { productionUrl?: string; rollback?: boolean },
) {
  const at = now()
  const release = releaseForProviderDeployment(projectPath, deployment)
  const records = readDeployments()
  if (release) {
    writeDeployments(
      transitionReleaseRecords(records, release.id, {
        productionUrl: input.productionUrl,
        rollback: Boolean(input.rollback),
        at,
      }),
    )
    return
  }
  writeDeployments(
    records.map((item) =>
      item.projectPath === projectPath && supportedDeployment(item) && item.releaseStatus === "current"
        ? {
            ...item,
            releaseStatus: input.rollback ? ("rolled-back" as const) : ("superseded" as const),
            rolledBackAt: input.rollback ? at : item.rolledBackAt,
          }
        : item,
    ),
  )
}

export function removeDeployment(projectPath: string, taskId: string | undefined, id: string): CloudDeployment[] {
  const records = readDeployments()
  const removed = records.find((item) => item.id === id && item.projectPath === projectPath)
  if (removed?.releaseStatus === "current") {
    throw new Error("Promote or roll back to another release before removing the live production deployment.")
  }
  const next = removed ? records.filter((item) => item.id !== id) : records
  writeDeployments(next)
  return next.filter((record) => record.projectPath === projectPath && supportedDeployment(record))
}

export function upsertDeploymentCheck(
  checks: CloudDeploymentCheck[],
  check: CloudDeploymentCheck,
): CloudDeploymentCheck[] {
  return [...checks.filter((item) => item.id !== check.id), check]
}

// ---- Per-project data (env vars + database) -------------------------------

type ProjectData = {
  env: StoredEnvVar[]
  database: CloudDatabaseConnection
  build: CloudBuildSettings | null
}

// A project's cloud state (env, database, build settings) belongs to
// the project, not to whichever chat session touched it. The Cloud Console
// renders with no taskId while the vector_cloud tool passes its session id, so
// keying on taskId gave the agent an empty second copy of everything the user
// had configured. `taskId` is still accepted across this module because the IPC
// and bridge callers pass it, but it deliberately does not reach the key.
//
// The literal "project" is load-bearing: it is exactly what the console has
// always hashed, so every record a user already has stays addressable. Hashing
// projectPath alone would be tidier and would orphan all of it.
export function cloudProjectScopeKey(projectPath: string): string {
  return createHash("sha256").update(`${projectPath}\nproject`).digest("hex").slice(0, 32)
}

function readProject(projectPath: string): ProjectData {
  const raw = getStore(PROJECTS_STORE).get(cloudProjectScopeKey(projectPath))
  if (!raw || typeof raw !== "object") return { env: [], database: null, build: null }
  const data = raw as Partial<ProjectData>
  const stored: unknown[] = Array.isArray(data.env) ? data.env : []
  const env = stored
    .map((item): StoredEnvVar | undefined => {
      if (!item || typeof item !== "object") return
      const key = Reflect.get(item, "key")
      if (typeof key !== "string") return
      const secret = Reflect.get(item, "secret")
      const visibility = Reflect.get(item, "visibility")
      if (typeof secret === "string") {
        return {
          key,
          secret,
          visibility: visibility === "public" || visibility === "server" ? visibility : envVisibility(key),
        }
      }
      // Older releases stored the value in plaintext. It is encrypted here and
      // written back below, so plaintext does not outlive the first read.
      const value = Reflect.get(item, "value")
      if (typeof value === "string")
        return { key, secret: encryptCloudCredential(value), visibility: envVisibility(key) }
    })
    .filter((item): item is StoredEnvVar => Boolean(item))
  const database =
    data.database && typeof data.database === "object" && data.database.provider === "supabase" ? data.database : null
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
  const project = { env, database, build }
  if (stored.some((item) => item && typeof item === "object" && typeof Reflect.get(item, "value") === "string")) {
    writeProject(projectPath, project)
  }
  return project
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

function writeProject(projectPath: string, data: ProjectData) {
  const store = getStore(PROJECTS_STORE)
  store.set(cloudProjectScopeKey(projectPath), data)
  // Environment values here are vault-encrypted, but names, database and domain
  // details are not, and electron-store creates the file with the process umask
  // (0644). It also rewrites the file atomically through a temp file plus
  // rename, which drops the mode again, so the tightening is reapplied on every
  // write.
  chmodSync(store.path, 0o600)
}

// `secrets` are values known only to the caller, such as the provider token it
// put in a child's environment: a Vercel token has no prefix redactText knows.
export function redactCloudLog(
  projectPath: string,
  taskId: string | undefined,
  value: string,
  secrets: (string | undefined)[] = [],
): string {
  // Two layers, and both are needed: the stored env values and the caller's
  // secrets catch exact strings, and redactText catches everything a build or
  // provider prints that Vector never held, such as bearer headers and
  // token-shaped strings.
  return redactText(
    [...listEnv(projectPath).map((item) => item.value), ...secrets].reduce<string>(
      (output, secret) => (secret && secret.length >= 4 ? output.split(secret).join("[redacted]") : output),
      value,
    ),
  )
}

// ---- Build and runtime -----------------------------------------------------

export function getBuildSettings(projectPath: string, taskId?: string): CloudBuildSettings | null {
  if (!(projectPath ?? "").trim()) return null
  return readProject(projectPath).build
}

// `directory` is where the files are read from: an agent's worktree detects its
// own package.json while the settings stay with the project it belongs to.
export async function detectBuildSettings(
  projectPath: string,
  taskId?: string,
  directory = projectPath,
): Promise<CloudBuildSettings> {
  const stats = directory ? await stat(directory).catch(() => undefined) : undefined
  if (!stats?.isDirectory()) throw new Error("Open a project folder before detecting its build settings.")

  const packageJson = await readFile(join(directory, "package.json"), "utf8")
    .then(parsePackageManifest)
    .catch(() => undefined)

  const packageManager = await detectPackageManager(directory, Boolean(packageJson))
  const hasNpmLock = Boolean(await stat(join(directory, "package-lock.json")).catch(() => undefined))
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
  const data = readProject(projectPath)
  writeProject(projectPath, { ...data, build: settings })
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
  const data = readProject(path)
  writeProject(path, { ...data, build: settings })
  return settings
}

// The release check sends the project's Protection Bypass secret to the health
// URL, so the path must stay on the release's own address: `//host/x`, `/\host`
// and a path with a tab or newline the URL parser drops all resolve elsewhere.
const HEALTH_BASE = "https://release.invalid"

export function normalizeHealthPath(value: string): string {
  const path = (value ?? "").trim() || "/"
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new Error("Health checks use a path such as / or /api/health, not a full URL.")
  }
  const normalized = path.startsWith("/") ? path : `/${path}`
  if (/[\\\s]/.test(normalized) || new URL(normalized, HEALTH_BASE).origin !== HEALTH_BASE) {
    throw new Error("Health checks use a path on the release's own address, such as / or /api/health.")
  }
  return normalized
}

// ---- Environment variables ------------------------------------------------

// Bundlers inline variables with these prefixes into browser code (Vite,
// Next.js, Astro and SvelteKit, Create React App, Expo, Nuxt, Gatsby, Vue CLI,
// Storybook), so anything under them is public once the app is built.
const CLIENT_ENV_PREFIXES = [
  "VITE_",
  "NEXT_PUBLIC_",
  "PUBLIC_",
  "REACT_APP_",
  "EXPO_PUBLIC_",
  "NUXT_PUBLIC_",
  "GATSBY_",
  "VUE_APP_",
  "STORYBOOK_",
]

export function clientEnvPrefix(key: string): string | undefined {
  return CLIENT_ENV_PREFIXES.find((prefix) => key.startsWith(prefix))
}

function envVisibility(key: string): CloudEnvVisibility {
  return clientEnvPrefix(key) ? "public" : "server"
}

export function listEnv(projectPath: string, taskId?: string): CloudEnvVar[] {
  return readProject(projectPath).env.map((item) => ({
    key: item.key,
    value: decryptEnvValue(item),
    visibility: item.visibility,
  }))
}

function decryptEnvValue(item: StoredEnvVar): string {
  try {
    return decryptCloudCredential(item.secret)
  } catch {
    throw new Error(
      `The saved value of ${item.key} cannot be decrypted on this device. Remove it in Vector Cloud > Environment variables and set it again.`,
    )
  }
}

export function setEnv(
  projectPath: string,
  taskId: string | undefined,
  key: string,
  value: string,
  visibility?: CloudEnvVisibility,
): CloudEnvVar[] {
  const trimmedKey = (key ?? "").trim()
  if (!KEY_PATTERN.test(trimmedKey)) {
    throw new Error(
      `"${trimmedKey}" is not a valid environment variable name. Use letters, digits and underscores, starting with a letter or underscore.`,
    )
  }
  const prefix = clientEnvPrefix(trimmedKey)
  if (visibility === "server" && prefix) {
    throw new Error(
      `${trimmedKey} starts with ${prefix}, which puts its value into browser code. Give a server-only value a name without that prefix.`,
    )
  }
  const entry = {
    key: trimmedKey,
    secret: encryptCloudCredential(value),
    visibility: visibility ?? envVisibility(trimmedKey),
  }
  const data = readProject(projectPath)
  const nextEnv = data.env.some((item) => item.key === trimmedKey)
    ? data.env.map((item) => (item.key === trimmedKey ? entry : item))
    : [...data.env, entry]
  writeProject(projectPath, { ...data, env: nextEnv })
  return listEnv(projectPath)
}

export function removeEnv(projectPath: string, taskId: string | undefined, key: string): CloudEnvVar[] {
  const data = readProject(projectPath)
  writeProject(projectPath, { ...data, env: data.env.filter((item) => item.key !== key) })
  return listEnv(projectPath)
}

// The real payoff: flush the stored vars into the project's actual .env. Any
// lines the user wrote above the Vector marker are preserved; the managed block
// below the marker is rewritten from scratch. `directory` is where the .env is
// written: an agent's worktree gets the variables of the project it belongs to.
export async function applyEnv(
  projectPath: string,
  taskId?: string,
  directory = projectPath,
): Promise<{ written: string; gitignoreUpdated: boolean }> {
  const stats = directory ? await stat(directory).catch(() => undefined) : undefined
  if (!stats?.isDirectory()) {
    throw new Error("Open a project folder before applying environment variables.")
  }
  const project = readProject(projectPath)
  const vars = listEnv(projectPath)
  for (const item of vars) {
    if (/[\r\n]/.test(item.value)) {
      throw new Error(
        `The value for "${item.key}" contains a line break, which cannot be written to .env. Remove it here and set it in the On Vercel panel of Environment variables, which sends it to the linked Vercel project without writing .env.`,
      )
    }
  }
  // A .env that git tracks goes out with the next commit, so it never takes a
  // server-only value. One git does not track is kept out of git before it
  // gets any value; a .gitignore that is a link or directory is the user's own
  // arrangement and is left alone.
  const server = vars.filter((item) => item.visibility === "server").map((item) => item.key)
  if (server.length && (await envTracked(directory))) {
    throw new Error(
      `Vector did not write .env, because this repository commits it to git and it would hold the server-only ${server.length === 1 ? "value" : "values"} ${server.join(", ")}. Stop tracking it with \`git rm --cached .env\` (the file stays on disk), commit that, then write .env again.`,
    )
  }
  const ignored = await ensureEnvIgnored(directory).catch(() => ({ added: false }))
  const manifest = await readFile(join(directory, "package.json"), "utf8")
    .then(parsePackageManifest)
    .catch(() => undefined)
  const vite =
    project.build?.framework === "Vite" || Boolean(manifest?.dependencies.vite || manifest?.devDependencies.vite)
  const envPath = join(directory, ".env")
  const existingFile = await lstat(envPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  if (existingFile && !existingFile.isFile()) {
    throw new Error("The project's .env must be a regular file, not a symbolic link or directory.")
  }
  const existing = await open(envPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    .then(async (file) => {
      try {
        return await file.readFile("utf8")
      } finally {
        await file.close()
      }
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return ""
    })
  const markerIndex = existing.indexOf(ENV_MARKER)
  const preamble = (markerIndex >= 0 ? existing.slice(0, markerIndex) : existing).replace(/\s+$/, "")
  const managed = [
    ENV_MARKER,
    ...vars.map((item) => `${item.key}=${vite ? formatViteEnvValue(item.value) : formatEnvValue(item.value)}`),
  ].join("\n")
  const output = preamble ? `${preamble}\n\n${managed}\n` : `${managed}\n`
  // Replace the directory entry rather than following a link swapped in after
  // the read. A fresh private file also tightens older permissive .env files.
  const temporary = join(directory, `.env.vector-${randomUUID()}`)
  try {
    await writeFile(temporary, output, { encoding: "utf8", flag: "wx", mode: 0o600 })
    await rename(temporary, envPath)
  } finally {
    await rm(temporary, { force: true })
  }
  return { written: ".env", gitignoreUpdated: ignored.added }
}

function formatEnvValue(value: string) {
  if (value === "") return '""'
  if (!/[\s#'"\\]/.test(value)) return value
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function formatViteEnvValue(value: string) {
  // Vite's dotenv-expand treats dollars as references even inside quotes.
  // Preserve backslashes verbatim; double quotes would also decode \n and \r.
  // Other projects retain their existing parser-specific representation.
  const quote = ["'", "`", '"'].find(
    (candidate) => !value.includes(candidate) && (candidate !== '"' || !/\\[nr]/.test(value)),
  )
  if (!quote) {
    throw new Error(
      "A variable contains a combination of quotes that cannot be written literally for Vite. Remove it here and set it in the On Vercel panel of Environment variables, which sends it to the linked Vercel project without writing .env.",
    )
  }
  return `${quote}${value.replace(/\$/g, "\\$")}${quote}`
}

// ---- Custom domains -------------------------------------------------------

// Lowercase, strip protocol/path/trailing dot, and require something that
// looks like a real hostname with at least one dot.
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
  if (!path) throw new Error("Open a project first.")
  return path
}

// ---- Database connector (Supabase) ----------------------------------------

export function getDatabase(projectPath: string, taskId?: string): CloudDatabaseConnection {
  const database = readProject(projectPath).database
  // Records saved before the reference was stored still name their project in
  // the URL, and every Management API call needs it.
  if (!database || database.projectRef) return database
  return { ...database, projectRef: projectRefFromUrl(database.url) }
}

// Only the stored record changes; .env and the variables stay as they are.
export function saveDatabase(projectPath: string, connection: CloudDatabaseConnection): void {
  const data = readProject(projectPath)
  writeProject(projectPath, { ...data, database: connection })
}

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
  directory = projectPath,
) {
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
  if (!isSupabasePublicKey(anonKey)) {
    throw new Error(
      "Enter a Supabase publishable key or an anon public key. Secret and service-role keys cannot be used in browser code.",
    )
  }

  const connection: CloudDatabaseConnection = {
    provider: "supabase",
    url,
    anonKey,
    projectRef: input.projectRef?.trim() || projectRefFromUrl(url),
    projectName: input.projectName?.trim() || undefined,
    managedByOAuth: input.managedByOAuth === true,
    connectedAt: now(),
  }

  // Only the names the framework's bundler exposes to browser code, so a
  // Next.js app is not handed VITE_* values it can never read.
  const framework = await supabaseFramework(directory)
  const names = supabasePublicEnvNames(framework)
  setEnv(projectPath, taskId, names.url, url, "public")
  setEnv(projectPath, taskId, names.key, anonKey, "public")

  const data = readProject(projectPath)
  writeProject(projectPath, { ...data, database: connection })

  // A minimal client so `import { supabase }` just works. It never replaces an
  // existing file, and a locked src/ does not fail the connection.
  await scaffoldSupabaseClient(directory, framework).catch(() => undefined)
  return { ...connection, env: await applyEnv(projectPath, taskId, directory) }
}

export function disconnectDatabase(projectPath: string, taskId?: string): void {
  const data = readProject(projectPath)
  writeProject(projectPath, { ...data, database: null })
}
