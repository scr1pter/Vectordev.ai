import { readFile, readdir, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"

import { clientEnvPrefix, getBuildSettings, getDatabase, listEnv, type CloudDeploymentCheck } from "./cloud-console"
import {
  errorMessage,
  management,
  refPath,
  responseArray,
  serviceRoleKey,
  stringField,
  SupabaseApiError,
  supabaseContext,
  SupabaseSetupError,
  type SupabaseContext,
  type SupabaseOptions,
} from "./cloud-supabase-api"

// The security check a release has to pass while a Supabase project is linked:
// Supabase's own security advisors (tables without row level security, views
// that bypass it, exposed functions...), plus a scan of what Vector would ship
// for credentials that must stay on a server — in public environment
// variables, and in the built client bundle.
// https://supabase.com/docs/guides/database/database-advisors

export type AdvisorFinding = {
  name: string
  title: string
  level: "ERROR" | "WARN" | "INFO"
  detail?: string
  remediation?: string
  entity?: string
}

export type LeakFinding = { where: string; reason: string; level: "ERROR" | "WARN" }

export type SecurityReport = {
  status: "passed" | "failed" | "skipped"
  project?: { ref: string; name: string }
  advisors: AdvisorFinding[]
  advisorsError?: string
  environment: LeakFinding[]
  bundle: LeakFinding[]
  errors: number
  warnings: number
  checkedAt: string
  detail: string
  /** What the user can do when the check could not run. */
  nextStep?: string
}

const MAX_SCAN_FILES = 2_000
const MAX_SCAN_BYTES = 5 * 1024 * 1024
const SKIP = new Set(["node_modules", ".git"])
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
const SECRET_NAME = /SERVICE_ROLE|SECRET|PASSWORD|PRIVATE/i

export async function securityCheck(
  input: { projectPath: string; taskId?: string; deployRoot?: string; directory?: string },
  options: SupabaseOptions = {},
): Promise<SecurityReport> {
  const checkedAt = new Date().toISOString()
  const database = getDatabase(input.projectPath, input.taskId)
  if (!database?.projectRef) {
    return empty("skipped", checkedAt, "No Supabase project is linked, so there is nothing to check.")
  }
  const context = await supabaseContext(input, options).catch((error: unknown) => {
    if (error instanceof SupabaseSetupError) return undefined
    throw error
  })
  const advisors = context
    ? await securityAdvisors(context).then(
        (findings) => ({ findings, error: undefined, status: undefined }),
        (error: unknown) => ({
          findings: [],
          error: errorMessage(error),
          status: error instanceof SupabaseApiError ? error.status : undefined,
        }),
      )
    : {
        findings: [],
        error: "Supabase is not connected on this machine, so its advisors were not run.",
        status: undefined,
      }
  // The exact key matters most: a service key anywhere public is a full bypass
  // of row level security, whatever its shape.
  const serviceKey = context ? await serviceRoleKey(context).catch(() => undefined) : undefined
  const environment = environmentLeaks(input.projectPath, input.taskId, serviceKey)
  const root = input.deployRoot ?? (input.directory ? await builtOutput(input) : undefined)
  const bundle = root ? await bundleLeaks(root, serviceKey) : []
  const all = [...advisors.findings, ...environment, ...bundle]
  const errors = all.filter((item) => item.level === "ERROR").length
  const warnings = all.filter((item) => item.level === "WARN").length
  // Advisors that could not run while Supabase is connected fail closed: a
  // production release is not waved through on a check that did not happen.
  // The exception is a connection that is not allowed to read them (an OAuth
  // connection made before Vector asked for that access): that is skipped
  // with a warning, so it does not stop every release until a reconnect.
  const forbidden = advisors.status === 403
  const status =
    errors || (context && advisors.error && !forbidden) ? "failed" : context && !forbidden ? "passed" : "skipped"
  return {
    status,
    project: { ref: database.projectRef, name: database.projectName ?? database.projectRef },
    advisors: advisors.findings,
    advisorsError: advisors.error,
    environment,
    bundle,
    errors,
    warnings,
    checkedAt,
    detail:
      status === "skipped"
        ? forbidden
          ? `Supabase's security advisors did not run, because Vector's Supabase connection is not allowed to read them. The local scan found nothing.`
          : `Connect Supabase in Vector Cloud > Connections to run the security advisors. The local scan found nothing.`
        : status === "failed"
          ? errors
            ? `${errors} security problem${errors === 1 ? "" : "s"} must be fixed before a production release.`
            : `Supabase's security advisors could not run: ${advisors.error}`
          : warnings
            ? `No blocking problems; ${warnings} warning${warnings === 1 ? "" : "s"} to review.`
            : "No security problems found.",
    nextStep: advisorsNextStep(errors ? undefined : advisors.status, Boolean(context && advisors.error)),
  }
}

// Only for a check that did not happen: real findings say what to fix. A 403
// is skipped rather than failed, so it needs no way around the check.
function advisorsNextStep(status: number | undefined, failed: boolean) {
  if (!failed) return
  const optional =
    "To release without it meanwhile, make Secret scan optional under Vector Cloud > Build & runtime > Required release checks."
  if (status === 403) {
    return "Reconnect Supabase in Vector Cloud > Connections and grant the access it asks for, or connect with a personal access token."
  }
  if (status === 401) {
    return `Reconnect Supabase in Vector Cloud > Connections, or connect with a personal access token. ${optional}`
  }
  return `Run the check again in a moment. ${optional}`
}

function empty(status: SecurityReport["status"], checkedAt: string, detail: string): SecurityReport {
  return { status, advisors: [], environment: [], bundle: [], errors: 0, warnings: 0, checkedAt, detail }
}

// https://supabase.com/docs/reference/api/v1-get-security-advisors
async function securityAdvisors(context: SupabaseContext): Promise<AdvisorFinding[]> {
  const body = await management(context, refPath(context, "/advisors/security"))
  return responseArray(body, "lints")
    .map((lint): AdvisorFinding | undefined => {
      const name = stringField(lint, "name")
      if (!name) return
      const level = stringField(lint, "level")
      const metadata = lint && typeof lint === "object" ? Reflect.get(lint, "metadata") : undefined
      const schema = stringField(metadata, "schema")
      const entity = stringField(metadata, "name") ?? stringField(metadata, "entity")
      return {
        name,
        title: stringField(lint, "title") ?? name,
        level: level === "ERROR" ? "ERROR" : level === "WARN" ? "WARN" : "INFO",
        detail: stringField(lint, "detail") ?? stringField(lint, "description"),
        remediation: stringField(lint, "remediation"),
        entity: entity ? (schema ? `${schema}.${entity}` : entity) : undefined,
      }
    })
    .filter((item): item is AdvisorFinding => Boolean(item))
}

// Names, never values: the finding says which variable and why.
function environmentLeaks(projectPath: string, taskId: string | undefined, serviceKey?: string): LeakFinding[] {
  return listEnv(projectPath, taskId)
    .filter((item) => item.visibility === "public" || clientEnvPrefix(item.key))
    .flatMap((item): LeakFinding[] => {
      const reason = secretKind(item.value, serviceKey)
      if (reason) return [{ where: item.key, reason: `is public but holds ${reason}`, level: "ERROR" }]
      if (SECRET_NAME.test(item.key)) {
        return [{ where: item.key, reason: "is public but its name suggests a secret", level: "WARN" }]
      }
      return []
    })
}

function secretKind(value: string, serviceKey?: string) {
  if (serviceKey && value.includes(serviceKey)) return "this project's service key"
  if (/\bsb_secret_[A-Za-z0-9_-]{8,}/.test(value)) return "a Supabase secret key"
  if (/\bsbp_[A-Za-z0-9]{20,}/.test(value)) return "a Supabase access token"
  if (/postgres(?:ql)?:\/\/[^:\s/@]+:[^@\s]+@/i.test(value)) return "a database password"
  if (Array.from(value.matchAll(JWT)).some((match) => jwtRole(match[0]) === "service_role")) {
    return "a service_role key"
  }
}

function jwtRole(token: string) {
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))
    return stringField(payload, "role")
  } catch {
    return undefined
  }
}

// The last build's output, when there is one: the configured output directory,
// or the usual dist/build/out.
async function builtOutput(input: { projectPath: string; taskId?: string; directory?: string }) {
  const directory = input.directory ?? input.projectPath
  const configured = getBuildSettings(input.projectPath, input.taskId)?.outputDirectory
  const candidates = configured && configured !== "." ? [configured] : ["dist", "build", "out"]
  for (const candidate of candidates) {
    if ((await stat(join(directory, candidate)).catch(() => undefined))?.isDirectory())
      return join(directory, candidate)
  }
}

// The build output is what browsers download, so anything here is public.
async function bundleLeaks(root: string, serviceKey?: string): Promise<LeakFinding[]> {
  if (!(await stat(root).catch(() => undefined))?.isDirectory()) return []
  const files: string[] = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES || SKIP.has(entry.name)) continue
      if (entry.isDirectory()) await walk(join(directory, entry.name))
      else if (entry.isFile()) files.push(join(directory, entry.name))
    }
  }
  await walk(root)
  const findings = await Promise.all(
    files.map(async (file): Promise<LeakFinding | undefined> => {
      if ((await stat(file)).size > MAX_SCAN_BYTES) return
      const reason = secretKind(await readFile(file, "utf8"), serviceKey)
      if (!reason) return
      return { where: relative(root, file).split(sep).join("/"), reason: `ships ${reason}`, level: "ERROR" }
    }),
  )
  return findings.filter((item): item is LeakFinding => Boolean(item))
}

// The release check publish runs before production changes. It is required
// whenever the secret scan is (Build & runtime > required checks).
export async function supabaseReleaseCheck(
  input: { projectPath: string; taskId?: string; deployRoot?: string; directory?: string; required: boolean },
  options: SupabaseOptions = {},
): Promise<CloudDeploymentCheck | undefined> {
  const startedAt = Date.now()
  if (!getDatabase(input.projectPath, input.taskId)?.projectRef) return
  const report = await securityCheck(input, options).catch(
    (error: unknown): SecurityReport => ({
      ...empty("failed", new Date().toISOString(), `The security check could not run: ${errorMessage(error)}`),
    }),
  )
  return {
    id: "supabase-security",
    type: "secrets",
    label: "Supabase security",
    status: report.status,
    required: input.required,
    details: [report.detail, report.nextStep].filter(Boolean).join(" "),
    output: [
      ...report.advisors
        .filter((item) => item.level !== "INFO")
        .map((item) => `${item.level} · ${item.title}${item.entity ? ` · ${item.entity}` : ""}`),
      ...report.environment.map((item) => `${item.level} · ${item.where} ${item.reason}`),
      ...report.bundle.map((item) => `${item.level} · ${item.where} ${item.reason}`),
    ].join("\n"),
    durationMs: Date.now() - startedAt,
    checkedAt: report.checkedAt,
  }
}
