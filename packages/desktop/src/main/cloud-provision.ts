import { randomBytes } from "node:crypto"
import { basename } from "node:path"

import {
  applyEnv,
  cloudProjectScopeKey,
  connectDatabase,
  getDatabase,
  type CloudDatabaseConnection,
} from "./cloud-console"
import { decryptCloudCredential, encryptCloudCredential } from "./cloud-credential-vault"
import { getStore } from "./store"

// Vector could only ever link a Supabase project the user had already created,
// which turns "add signup" into a dashboard errand in the middle of a build.
// This module creates the project on the user's own account and then hands off
// to the same connectDatabase the manual flow uses, so the end state is
// indistinguishable from a hand-linked project: database_status,
// prepare_database, supabase_services and apply_migrations all keep working.
//
// Two decisions are deliberately not the model's to make: which organization
// pays for and owns the project, and whether the plan allows another project at
// all. Both are answered by Supabase and reported back verbatim.

type CloudFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type SupabaseOrganization = { id: string; name: string; plan?: string }

export type CloudProvisionDatabase = {
  connected: true
  provider: "supabase"
  host: string
  projectRef?: string
  projectName?: string
  region?: string
  dashboardUrl?: string
}

export type CloudProvisionReport = {
  ok: boolean
  needsSetup?: boolean
  needsChoice?: boolean
  createdNow?: boolean
  error?: string
  nextStep?: string
  database?: CloudProvisionDatabase
  organizations?: SupabaseOrganization[]
  applied?: { written: string }
  waitedMs?: number
}

export type CloudProvisionInput = {
  projectPath: string
  taskId?: string
  organizationId?: string
  region?: string
  force?: boolean
}

export type CloudProvisionOptions = {
  request?: CloudFetch
  wait?: (ms: number) => Promise<void>
  pollAttempts?: number
  pollIntervalMs?: number
}

const API = "https://api.supabase.com/v1"
const CONNECTION_STORE = "cloud-provider-connections"
const CONNECTION_KEY = "records"
const PROVISION_STORE = "cloud-database-credentials"
const DEFAULT_REGION = "us-east-1"
// Supabase takes a couple of minutes to bring a new project up; three and a bit
// covers a slow one without ever leaving the agent waiting on a dead project.
const DEFAULT_POLL_ATTEMPTS = 40
const DEFAULT_POLL_INTERVAL_MS = 5_000
// Leaves room for the "-2" a name collision appends and stays well under the
// length Supabase accepts for a project name.
const MAX_PROJECT_NAME = 48
const HEALTHY_STATUS = "ACTIVE_HEALTHY"
const FAILED_STATUSES = new Set(["INIT_FAILED", "RESTORE_FAILED", "REMOVED", "GOING_DOWN"])

class SupabaseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "SupabaseApiError"
  }
}

type ProvisionRecord = {
  projectRef: string
  projectName: string
  region: string
  organizationId: string
  password: string
  createdAt: string
  linkedAt?: string
}

function now(): string {
  return new Date().toISOString()
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = Reflect.get(value, key)
  return typeof field === "string" && field ? field : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function responseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object") return []
  const data = Reflect.get(value, "data")
  return Array.isArray(data) ? data : []
}

// cloud-connections keeps its Supabase token accessor module-private, so the
// management token is read back from the record it writes, through the same
// vault. There is no linked project to refresh against yet — the refresh path
// runs off a service snapshot that needs one — so an expired token is answered
// by Supabase with a 401 and reported as "reconnect", never guessed at.
function supabaseManagementToken(): string | undefined {
  const raw = getStore(CONNECTION_STORE).get(CONNECTION_KEY)
  if (!Array.isArray(raw)) return undefined
  const record = raw.find((item) => item && typeof item === "object" && Reflect.get(item, "provider") === "supabase")
  const accessToken = stringField(record, "accessToken")
  return accessToken ? decryptCloudCredential(accessToken) : undefined
}

// The generated database password is a real credential for a database the user
// now owns, so it is kept the way every other cloud credential is: encrypted
// with the runtime vault key. Unlike cloud-console's project file this one never
// holds plaintext, so it needs no extra tightening of the file mode.
function readProvisionRecord(projectPath: string): ProvisionRecord | undefined {
  const raw = getStore(PROVISION_STORE).get(cloudProjectScopeKey(projectPath))
  const projectRef = stringField(raw, "projectRef")
  const password = stringField(raw, "password")
  if (!raw || typeof raw !== "object" || !projectRef || !password) return undefined
  return {
    projectRef,
    projectName: stringField(raw, "projectName") ?? projectRef,
    region: stringField(raw, "region") ?? DEFAULT_REGION,
    organizationId: stringField(raw, "organizationId") ?? "",
    password,
    createdAt: stringField(raw, "createdAt") ?? now(),
    linkedAt: stringField(raw, "linkedAt"),
  }
}

function writeProvisionRecord(projectPath: string, record: ProvisionRecord): void {
  getStore(PROVISION_STORE).set(cloudProjectScopeKey(projectPath), record)
}

function clearProvisionRecord(projectPath: string): void {
  getStore(PROVISION_STORE).delete(cloudProjectScopeKey(projectPath))
}

async function supabaseJson(token: string, url: string, request: CloudFetch, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set("accept", "application/json")
  headers.set("authorization", `Bearer ${token}`)
  headers.set("user-agent", "Vector-Desktop/1")
  if (init?.body) headers.set("content-type", "application/json")
  const response = await request(url, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (response.ok) return body
  // The provider's own words: a quota, a payment hold or a rejected region is
  // something the user has to act on, and paraphrasing it hides what to do.
  throw new SupabaseApiError(
    stringField(body, "message") ??
      stringField(body, "error_description") ??
      stringField(body, "error") ??
      `Supabase returned HTTP ${response.status}.`,
    response.status,
  )
}

export function supabaseProjectName(projectPath: string): string {
  const name = basename(projectPath.trim())
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_PROJECT_NAME)
    .replace(/-+$/, "")
  return name || "vector-app"
}

export function uniqueProjectName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()).filter(Boolean))
  if (!used.has(base)) return base
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
  // A hundred projects called the same thing is not a case worth a nicer name.
  return `${base}-${randomBytes(3).toString("hex")}`
}

function databaseSummary(connection: NonNullable<CloudDatabaseConnection>, region?: string): CloudProvisionDatabase {
  return {
    connected: true,
    provider: "supabase",
    host: new URL(connection.url).hostname,
    projectRef: connection.projectRef,
    projectName: connection.projectName,
    region,
    dashboardUrl: connection.projectRef
      ? `https://supabase.com/dashboard/project/${encodeURIComponent(connection.projectRef)}`
      : undefined,
  }
}

async function listOrganizations(token: string, request: CloudFetch): Promise<SupabaseOrganization[]> {
  const body = await supabaseJson(token, `${API}/organizations`, request)
  return responseArray(body)
    .map((item): SupabaseOrganization | undefined => {
      const id = stringField(item, "id") ?? stringField(item, "slug")
      const name = stringField(item, "name") ?? id
      if (!id || !name) return
      return { id, name, plan: stringField(item, "plan") ?? stringField(item, "tier") }
    })
    .filter((item): item is SupabaseOrganization => Boolean(item))
}

async function listProjectNames(token: string, organizationId: string, request: CloudFetch): Promise<string[]> {
  const body = await supabaseJson(token, `${API}/projects`, request)
  return responseArray(body)
    .filter((item) => {
      const owner = stringField(item, "organization_id")
      // Names only have to be told apart inside the organization the new project
      // lands in; a same-named project in another org is not a collision.
      return !owner || owner === organizationId
    })
    .map((item) => stringField(item, "name"))
    .filter((name): name is string => Boolean(name))
}

type PollResult = { healthy: boolean; missing?: boolean; status?: string; region?: string; attempts: number }

// Bounded by construction: every path out of this loop is a report the agent can
// act on, and the caller is never left waiting on a project that will not come.
async function waitForHealthyProject(
  token: string,
  projectRef: string,
  options: {
    request: CloudFetch
    wait: (ms: number) => Promise<void>
    attempts: number
    intervalMs: number
    tolerateMissing: boolean
  },
): Promise<PollResult> {
  let status: string | undefined
  let region: string | undefined
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const project = await supabaseJson(
      token,
      `${API}/projects/${encodeURIComponent(projectRef)}`,
      options.request,
    ).catch((error: unknown) => {
      // A just-created project can be missing from the read API for a moment,
      // but a project Vector created in an earlier run and can no longer see was
      // deleted in the dashboard, and polling that for minutes helps nobody.
      if (error instanceof SupabaseApiError && error.status === 404) return "missing" as const
      throw error
    })
    if (project === "missing") {
      if (!options.tolerateMissing || attempt > 3) {
        return { healthy: false, missing: true, status, region, attempts: attempt }
      }
    } else {
      status = stringField(project, "status") ?? status
      region = stringField(project, "region") ?? region
      if (status === HEALTHY_STATUS) return { healthy: true, status, region, attempts: attempt }
      if (status && FAILED_STATUSES.has(status)) return { healthy: false, status, region, attempts: attempt }
    }
    if (attempt < options.attempts) await options.wait(options.intervalMs)
  }
  return { healthy: false, status, region, attempts: options.attempts }
}

async function fetchAnonKey(token: string, projectRef: string, request: CloudFetch): Promise<string> {
  // Exactly the selection cloud-connections makes when linking by hand: the
  // publishable key first, then the legacy anon key under either shape.
  const keys = await supabaseJson(token, `${API}/projects/${encodeURIComponent(projectRef)}/api-keys`, request)
  const values = responseArray(keys)
  const publicKeyRecord =
    values.find((item) => stringField(item, "type") === "publishable") ??
    values.find((item) => stringField(item, "name") === "anon") ??
    values.find((item) => stringField(item, "type") === "anon")
  const anonKey = stringField(publicKeyRecord, "api_key")
  if (!anonKey) throw new Error("Supabase did not expose a publishable or anon key for the new project.")
  return anonKey
}

async function linkCreatedProject(
  input: CloudProvisionInput,
  token: string,
  record: ProvisionRecord,
  poll: PollResult,
  request: CloudFetch,
): Promise<CloudProvisionReport> {
  const anonKey = await fetchAnonKey(token, record.projectRef, request)
  // The manual flow's own helper: it writes SUPABASE_URL/SUPABASE_ANON_KEY into
  // the project's managed env, scaffolds src/lib/supabase.js and flushes .env.
  const connection = await connectDatabase(input.projectPath, input.taskId, {
    provider: "supabase",
    url: `https://${record.projectRef}.supabase.co`,
    anonKey,
    projectRef: record.projectRef,
    projectName: record.projectName,
    managedByOAuth: true,
  })
  if (!connection) throw new Error("Vector could not record the new Supabase project for this project.")
  writeProvisionRecord(input.projectPath, { ...record, linkedAt: now() })
  return {
    ok: true,
    createdNow: true,
    database: databaseSummary(connection, poll.region ?? record.region),
    applied: await applyEnv(input.projectPath, input.taskId),
    nextStep:
      "The database is live and wired into .env. Write the schema as a .sql file and run apply_migrations to create the tables this feature needs.",
  }
}

// What the failure path needs to know about a run that did not reach a report:
// which secrets must never reach tool output, and whether a project that costs
// money already exists.
type ProvisionContext = { secrets: string[]; createdRef?: string }

async function provision(
  input: CloudProvisionInput,
  options: CloudProvisionOptions,
  context: ProvisionContext,
): Promise<CloudProvisionReport> {
  const request = options.request ?? fetch
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const attempts = Math.max(1, Math.trunc(options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS))
  const intervalMs = Math.max(0, Math.trunc(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS))

  // Checked before the account is: a project that already has a database does
  // not need one created, and saying "connect Supabase first" to someone who
  // linked their database by hand would be plainly wrong.
  const existing = getDatabase(input.projectPath, input.taskId)
  if (existing && input.force !== true) {
    return {
      ok: true,
      createdNow: false,
      database: databaseSummary(existing),
      nextStep:
        "This project already has a database connected, so nothing was created. Use prepare_database to wire it into the code, or call create_database with force to add a second Supabase project anyway.",
    }
  }

  const token = supabaseManagementToken()
  if (!token) {
    return {
      ok: false,
      needsSetup: true,
      error: "Supabase is not connected on this machine.",
      nextStep:
        "Ask the user to connect Supabase in Vector Cloud > Connections, then run create_database again. If they already have a Supabase project they want to use, they can link it in Vector Cloud > Database instead.",
    }
  }
  context.secrets.push(token)

  const previous = input.force === true ? undefined : readProvisionRecord(input.projectPath)
  // Only a record that never finished linking is resumed: the poll timed out or
  // the app closed mid-creation, and finishing that project is the difference
  // between one project and two on an account whose plan may only allow two. A
  // record that did link and was later disconnected on purpose is history, not
  // an unfinished job, so it does not silently re-link the old project.
  const pending = previous?.linkedAt ? undefined : previous
  if (pending) {
    context.createdRef = pending.projectRef
    const resumed = await waitForHealthyProject(token, pending.projectRef, {
      request,
      wait,
      attempts,
      intervalMs,
      tolerateMissing: false,
    })
    if (resumed.healthy) return linkCreatedProject(input, token, pending, resumed, request)
    if (resumed.missing) {
      clearProvisionRecord(input.projectPath)
      return {
        ok: false,
        error: `The Supabase project Vector created earlier (${pending.projectName}) is no longer on this account.`,
        nextStep: "It was probably deleted in the dashboard. Run create_database again to create a new one.",
      }
    }
    return notHealthyReport(pending, resumed, intervalMs)
  }

  const organizations = await listOrganizations(token, request)
  if (!organizations.length) {
    return {
      ok: false,
      needsSetup: true,
      error: "This Supabase account has no organizations, so there is nothing to create a project in.",
      nextStep: "Ask the user to create an organization at supabase.com/dashboard, then run create_database again.",
    }
  }
  const chosen = input.organizationId
    ? organizations.find((item) => item.id === input.organizationId)
    : organizations.length === 1
      ? organizations[0]
      : undefined
  if (!chosen) {
    // Creating a project in the wrong organization bills the wrong account and
    // gives the wrong people access, so a several-organization account is a
    // question for the user rather than a coin flip.
    return {
      ok: false,
      needsChoice: true,
      organizations,
      error: input.organizationId
        ? `This Supabase account has no organization with id ${input.organizationId}.`
        : "This Supabase account has more than one organization, and the new project has to belong to one of them.",
      nextStep:
        "Ask the user which organization the database should live in, then call create_database again with that organizationId.",
    }
  }

  const region = input.region?.trim() || DEFAULT_REGION
  const name = uniqueProjectName(
    supabaseProjectName(input.projectPath),
    await listProjectNames(token, chosen.id, request),
  )
  // 24 random bytes, base64url so nothing in it has to be escaped inside a
  // Postgres connection string. It is never returned and never logged.
  const password = randomBytes(24).toString("base64url")
  context.secrets.push(password)
  const created = await supabaseJson(token, `${API}/projects`, request, {
    method: "POST",
    body: JSON.stringify({ name, organization_id: chosen.id, region, db_pass: password }),
  })
  const projectRef = stringField(created, "ref") ?? stringField(created, "id")
  if (!projectRef) throw new Error("Supabase accepted the project but did not return its reference.")
  context.createdRef = projectRef

  const record: ProvisionRecord = {
    projectRef,
    projectName: stringField(created, "name") ?? name,
    region: stringField(created, "region") ?? region,
    organizationId: chosen.id,
    password: encryptCloudCredential(password),
    createdAt: now(),
  }
  // Written before the wait, not after: if the poll times out or the app quits,
  // the next run resumes this project instead of creating another one.
  writeProvisionRecord(input.projectPath, record)

  const poll = await waitForHealthyProject(token, projectRef, {
    request,
    wait,
    attempts,
    intervalMs,
    tolerateMissing: true,
  })
  if (!poll.healthy) return notHealthyReport(record, poll, intervalMs)
  return linkCreatedProject(input, token, record, poll, request)
}

function notHealthyReport(record: ProvisionRecord, poll: PollResult, intervalMs: number): CloudProvisionReport {
  const failed = Boolean(poll.status && FAILED_STATUSES.has(poll.status))
  const waitedMs = poll.attempts * intervalMs
  // The timeout is not a failure of the project, only of the wait, so it says
  // what exists and how to finish it — never "try creating one again".
  const resume = `Do not create another one. Run create_database again in a minute and it will finish linking this same project (${record.projectRef}).`
  return {
    ok: false,
    waitedMs,
    error: failed
      ? `Supabase reported ${record.projectName} as ${poll.status} instead of bringing it up.`
      : poll.missing
        ? `${record.projectName} was created, but Supabase is not listing it on the account yet.`
        : `${record.projectName} was created but is still ${poll.status ?? "starting"} after ${Math.round(waitedMs / 1000)}s.`,
    nextStep: failed
      ? `Ask the user to check ${record.projectName} at https://supabase.com/dashboard/project/${record.projectRef}. Nothing is connected to this project yet.`
      : resume,
  }
}

export async function createCloudDatabase(
  input: CloudProvisionInput,
  options: CloudProvisionOptions = {},
): Promise<CloudProvisionReport> {
  // Anything secret this run generated or read is stripped from the message
  // before it becomes tool output: a provider validation error can quote the
  // value it rejected, and tool output is model context the user cannot unsee.
  const context: ProvisionContext = { secrets: [] }
  const scrub = (value: string) =>
    context.secrets.reduce((output, secret) => (secret ? output.split(secret).join("[redacted]") : output), value)
  try {
    return await provision(input, options, context)
  } catch (error) {
    const message = scrub(errorMessage(error))
    const status = error instanceof SupabaseApiError ? error.status : undefined
    // A project that was created and then failed to link must never be reported
    // as "nothing happened": the user is already paying for it, and the next run
    // has to finish that one instead of buying a second.
    const created = context.createdRef
    const resume = created
      ? ` The project Vector created (${created}) does exist, so do not create another one — run create_database again to finish linking it.`
      : ""
    if (status === 401) {
      return {
        ok: false,
        needsSetup: true,
        error: `Supabase rejected Vector's saved credentials: ${message}`,
        nextStep: `Ask the user to reconnect Supabase in Vector Cloud > Connections, then run create_database again.${resume}`,
      }
    }
    if (created) {
      return {
        ok: false,
        error: `The Supabase project was created, but Vector could not finish connecting it: ${message}`,
        nextStep: `Run create_database again to finish linking ${created}, or ask the user to check https://supabase.com/dashboard/project/${created}. Do not create another project.`,
      }
    }
    // Free organizations cap how many projects they may hold, and a card on
    // file can still be declined. That is the user's decision to make, not a
    // crash and not something to retry.
    const limited = status === 402 || status === 403 || /limit|quota|exceed|payment|billing|upgrade/i.test(message)
    return {
      ok: false,
      error: `Supabase would not create the project: ${message}`,
      nextStep: limited
        ? "This is Supabase's own limit, not Vector's. Ask the user to free up or reuse a project in that organization, choose another organization, or upgrade its plan — then run create_database again. An existing project can be linked in Vector Cloud > Database instead."
        : "Report this to the user as Supabase reported it, and offer to link an existing Supabase project in Vector Cloud > Database instead.",
    }
  }
}
