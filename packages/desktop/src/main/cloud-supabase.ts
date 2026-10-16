import { getCloudProviderProjectLink } from "./cloud-connections"
import { getDatabase, listEnv } from "./cloud-console"
import { applyCloudMigrations } from "./cloud-migrations"
import type { CloudProvisionProgress } from "./cloud-provision"
import { resolveCloudScope, type CloudWorkspace } from "./cloud-scope"
import {
  errorMessage,
  scrub,
  SupabaseApiError,
  supabaseContext,
  SupabaseSetupError,
  type SupabaseOptions,
} from "./cloud-supabase-api"
import {
  AUTH_PROVIDERS,
  authUserEmail,
  deleteAuthUser,
  getAuthConfig,
  inviteAuthUser,
  listAuthUsers,
  updateAuthConfig,
  vercelRedirectSuggestions,
  type AuthUpdate,
} from "./cloud-supabase-auth"
import {
  createMigrationFile,
  migrationStatus,
  plannedMigration,
  rollbackMigration,
  rollbackPlan,
  runSql,
} from "./cloud-supabase-database"
import {
  deleteFunction,
  deleteFunctionSecrets,
  deployFunction,
  listFunctions,
  listFunctionSecrets,
  setFunctionSecrets,
  verifyJwt,
} from "./cloud-supabase-functions"
import { rotateDatabasePassword, writeDatabaseUrl } from "./cloud-supabase-keys"
import { isLogService, LOG_SERVICES, readSupabaseLogs } from "./cloud-supabase-logs"
import {
  createSupabaseOrganization,
  createSupabaseProject,
  linkSupabaseProject,
  listSupabaseProjects,
  pauseSupabaseProject,
  restoreSupabaseProject,
  SUPABASE_REGIONS,
  supabaseOrganizationName,
  unlinkSupabaseProject,
} from "./cloud-supabase-projects"
import { securityCheck } from "./cloud-supabase-security"
import { createBucket, deleteBucket, listBuckets, updateBucket } from "./cloud-supabase-storage"

// One entry point for everything Vector does with a linked Supabase project,
// shared by the Cloud console (IPC) and the agent (the loopback bridge), so a
// feature that works in one works in the other. Every command answers with a
// report: { ok: true, ...data } or { ok: false, error, needsSetup?, nextStep? }.
// The agent's tool asks permission for each changing command first, using the
// scope `describeSupabaseCommand` gives it.

const READS = [
  "supabase_projects",
  "regions",
  "migration_status",
  "plan_migrations",
  "auth_config",
  "auth_users",
  "vercel_redirect_urls",
  "buckets",
  "functions",
  "supabase_services",
  "function_secrets",
  "supabase_logs",
  "security_check",
] as const

const CHANGES = [
  "create_organization",
  "create_project",
  "link_database",
  "unlink_database",
  "pause_database",
  "restore_database",
  "write_database_url",
  "rotate_database_password",
  "apply_migrations",
  "rollback_migration",
  "run_sql",
  "update_auth",
  "invite_user",
  "delete_user",
  "create_bucket",
  "update_bucket",
  "delete_bucket",
  "deploy_function",
  "delete_function",
  "set_function_secrets",
  "delete_function_secrets",
] as const

// Writes a file into the repository, as the agent's own edits do, and asks under
// the agent's edit permission; it touches no cloud account.
const LOCAL = ["create_migration"] as const

export const SUPABASE_COMMANDS = [...READS, ...CHANGES, ...LOCAL] as const
export type SupabaseCommand = (typeof SUPABASE_COMMANDS)[number]

export type SupabaseCaller = "console" | "agent"

export type SupabaseProgressEvent = CloudProvisionProgress & { projectPath: string }

export type SupabaseRunOptions = SupabaseOptions & {
  caller: SupabaseCaller
  workspaces?: () => CloudWorkspace[] | Promise<CloudWorkspace[]>
  progress?: (event: SupabaseProgressEvent) => void
}

export function isSupabaseCommand(value: unknown): value is SupabaseCommand {
  return SUPABASE_COMMANDS.some((item) => item === value)
}

type Input = Record<string, unknown>

export async function runSupabaseCommand(command: unknown, raw: unknown, options: SupabaseRunOptions) {
  if (!isSupabaseCommand(command)) return { ok: false, error: "Unsupported Supabase command." }
  const input: Input = raw && typeof raw === "object" ? (raw as Input) : {}
  const requested = text(input, "projectPath")
  if (!requested) return { ok: false, error: "Open a project before using Supabase." }
  // State belongs to the main project; files live where the agent works.
  const scope = await resolveCloudScope(requested, (await options.workspaces?.()) ?? [])
  const project = { projectPath: scope.projectPath, taskId: text(input, "taskId") }
  try {
    const data = await run(command, input, { ...project, directory: scope.directory }, options)
    if (data && typeof data === "object" && "ok" in data) return data
    return { ok: true, ...data }
  } catch (error) {
    if (error instanceof SupabaseSetupError) {
      return { ok: false, needsSetup: true, error: error.message, nextStep: error.nextStep }
    }
    const message = scrub({ ...project, secrets: [] }, errorMessage(error))
    const status = error instanceof SupabaseApiError ? error.status : undefined
    return {
      ok: false,
      error: message,
      nextStep:
        status === 401
          ? "Supabase rejected Vector's saved credentials. Reconnect Supabase in Vector Cloud > Connections."
          : status === 403
            ? "Vector's Supabase connection is not allowed to do this. Reconnect Supabase in Vector Cloud > Connections and grant the access it asks for, or connect with a personal access token."
            : undefined,
    }
  }
}

async function run(
  command: SupabaseCommand,
  input: Input,
  project: { projectPath: string; taskId?: string; directory: string },
  options: SupabaseRunOptions,
) {
  const agent = options.caller === "agent"
  if (command === "supabase_projects") return listSupabaseProjects(project, options)
  if (command === "regions") return { regions: SUPABASE_REGIONS }
  if (command === "create_organization") {
    return createSupabaseOrganization({ name: required(input, "organizationName") }, options)
  }
  if (command === "create_project") {
    return createSupabaseProject(
      { ...project, organizationId: text(input, "organizationId"), region: text(input, "region") },
      { ...options, progress: (event) => options.progress?.({ ...event, projectPath: project.projectPath }) },
    )
  }
  if (command === "link_database") {
    return linkSupabaseProject({ ...project, projectRef: required(input, "projectRef") }, options)
  }
  if (command === "unlink_database") return unlinkSupabaseProject(project)
  if (command === "migration_status") return migrationStatus(project, options)
  if (command === "create_migration") {
    return createMigrationFile({
      directory: project.directory,
      name: required(input, "name"),
      sql: required(input, "sql"),
      downSql: text(input, "downSql"),
      // The version the agent's edit prompt named; without it a new one is picked.
      version: text(input, "version"),
    })
  }
  if (command === "plan_migrations" || command === "apply_migrations") {
    return applyCloudMigrations(
      {
        ...project,
        prepare: command === "plan_migrations",
        dryRun: bool(input, "dryRun") === true,
        approvalID: text(input, "approvalID"),
      },
      options.request ?? fetch,
    )
  }
  if (command === "vercel_redirect_urls") return vercelRedirectSuggestions(project.projectPath, options.request)
  // Reports "skipped" by itself when Supabase is not linked or connected.
  if (command === "security_check") return { security: await securityCheck(project, options) }

  const context = await supabaseContext(project, options)
  if (command === "pause_database") return pauseSupabaseProject(context)
  if (command === "restore_database") return restoreSupabaseProject(context)
  if (command === "write_database_url") {
    // The agent's permission prompt for this action is the user's consent; the
    // console sends it after its own confirmation, with the current password
    // when the user typed one.
    if (agent && input.password !== undefined) {
      throw new Error("The database password is entered in Vector Cloud > Database, never through chat.")
    }
    return writeDatabaseUrl(context, {
      directory: project.directory,
      consent: agent || bool(input, "consent") === true,
      password: text(input, "password"),
    })
  }
  if (command === "rotate_database_password") {
    return rotateDatabasePassword(context, {
      directory: project.directory,
      writeDatabaseUrl: bool(input, "writeDatabaseUrl"),
      syncVercel: bool(input, "syncVercel"),
    })
  }
  if (command === "rollback_migration") {
    // The agent runs only the down SQL its permission prompt showed.
    const downChecksum = text(input, "downChecksum")
    if (agent && !downChecksum) throw new Error("Describe rollback_migration first, so the user sees its down SQL.")
    return rollbackMigration(context, { directory: project.directory, name: text(input, "name"), downChecksum })
  }
  if (command === "run_sql") {
    return runSql(context, {
      sql: required(input, "sql"),
      write: bool(input, "write"),
      maxRows: num(input, "maxRows"),
      caller: options.caller,
    })
  }
  if (command === "auth_config") return { auth: await getAuthConfig(context) }
  if (command === "update_auth") {
    const update = authUpdate(input, agent)
    if (bool(input, "addVercelUrls") === true) {
      const suggestions = await vercelRedirectSuggestions(project.projectPath, options.request)
      if (!suggestions.redirectUrls.length)
        throw new SupabaseSetupError("No Vercel addresses to add.", suggestions.detail ?? "")
      update.addRedirectUrls = [...(update.addRedirectUrls ?? []), ...suggestions.redirectUrls]
    }
    return updateAuthConfig(context, update)
  }
  if (command === "auth_users")
    return listAuthUsers(context, { page: num(input, "page"), perPage: num(input, "perPage") })
  if (command === "invite_user") {
    return inviteAuthUser(context, { email: required(input, "email"), redirectTo: text(input, "redirectTo") })
  }
  if (command === "delete_user") return deleteAuthUser(context, { userId: required(input, "userId") })
  if (command === "buckets") return listBuckets(context)
  if (command === "create_bucket" || command === "update_bucket") {
    const bucket = {
      name: required(input, "bucket"),
      public: bool(input, "public"),
      fileSizeLimit: input.fileSizeLimit === null ? null : num(input, "fileSizeLimit"),
      allowedMimeTypes: input.allowedMimeTypes === null ? null : list(input, "allowedMimeTypes"),
    }
    return command === "create_bucket" ? createBucket(context, bucket) : updateBucket(context, bucket)
  }
  if (command === "delete_bucket") {
    return deleteBucket(context, { name: required(input, "bucket"), empty: bool(input, "empty") })
  }
  if (command === "functions") return listFunctions(context, project.directory)
  // The agent's overview of storage and Edge Functions. Either half can fail on
  // its own (a token without storage access) without hiding the other.
  if (command === "supabase_services") {
    const part = <T>(work: Promise<T>) =>
      work.then(
        (value) => ({ available: true, ...value }),
        (error: unknown) => ({ available: false, error: scrub(context, errorMessage(error)) }),
      )
    const [storage, functions] = await Promise.all([
      part(listBuckets(context)),
      part(listFunctions(context, project.directory)),
    ])
    return { services: { project: { ref: context.projectRef, name: context.projectName }, storage, functions } }
  }
  if (command === "deploy_function") {
    return deployFunction(context, { directory: project.directory, name: required(input, "functionName") })
  }
  if (command === "delete_function") return deleteFunction(context, { slug: required(input, "functionName") })
  if (command === "function_secrets") return listFunctionSecrets(context)
  if (command === "set_function_secrets") {
    if (agent && input.secrets !== undefined) {
      throw new Error(
        "Secret values are entered in Vector Cloud > Edge functions, never through chat. Pass names from this project's environment instead.",
      )
    }
    return setFunctionSecrets(context, { secrets: secretPairs(input), fromEnv: list(input, "secretNames") })
  }
  if (command === "delete_function_secrets") {
    return deleteFunctionSecrets(context, { names: list(input, "secretNames") ?? [] })
  }
  if (command === "supabase_logs") {
    const service = input.service
    if (!isLogService(service)) {
      throw new Error(`Choose a log service: ${Object.keys(LOG_SERVICES).join(", ")}.`)
    }
    return readSupabaseLogs(context, {
      service,
      minutes: num(input, "minutes"),
      limit: num(input, "limit"),
      search: text(input, "search"),
    })
  }
  return { ok: false, error: `Unsupported Supabase command: ${command}.` }
}

function authUpdate(input: Input, agent: boolean): AuthUpdate {
  const providers: AuthUpdate["providers"] = {}
  const raw = input.providers && typeof input.providers === "object" ? (input.providers as Input) : {}
  for (const name of AUTH_PROVIDERS) {
    const value = raw[name]
    if (!value || typeof value !== "object") continue
    const change = value as Input
    if (agent && change.secret !== undefined) {
      throw new Error(
        "OAuth client secrets are entered in Vector Cloud > Authentication, never through chat, so they stay out of the conversation.",
      )
    }
    providers[name] = {
      enabled: bool(change, "enabled"),
      clientId: text(change, "clientId"),
      secret: text(change, "secret"),
    }
  }
  return {
    siteUrl: text(input, "siteUrl"),
    redirectUrls: agent ? undefined : list(input, "redirectUrls"),
    addRedirectUrls: list(input, agent ? "redirectUrls" : "addRedirectUrls"),
    removeRedirectUrls: list(input, "removeRedirectUrls"),
    emailEnabled: bool(input, "emailEnabled"),
    providers,
  }
}

function secretPairs(input: Input) {
  if (!Array.isArray(input.secrets)) return undefined
  return input.secrets.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Each secret needs a name and a value.")
    const pair = item as Input
    return { name: required(pair, "name"), value: typeof pair.value === "string" ? pair.value : "" }
  })
}

function text(input: Input, key: string) {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new Error(`${key} must be text.`)
  return value.trim() || undefined
}

function required(input: Input, key: string) {
  const value = text(input, key)
  if (!value) throw new Error(`${key} is required.`)
  return value
}

function bool(input: Input, key: string) {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "boolean") throw new Error(`${key} must be true or false.`)
  return value
}

function num(input: Input, key: string) {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number.`)
  return value
}

function list(input: Input, key: string) {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be a list of text.`)
  }
  return value.map((item: string) => item.trim()).filter(Boolean)
}

// What a changing command would do, worded for the agent's permission prompt:
// provider, project, environment, a one-line summary and any SQL it would run.
// Every one of them asks each time (PermissionPolicy). `approved` goes back
// with the command, so the run does exactly what the prompt showed.
export async function describeSupabaseCommand(
  command: SupabaseCommand,
  raw: unknown,
  workspaces: CloudWorkspace[],
  options: SupabaseOptions = {},
) {
  const input: Input = raw && typeof raw === "object" ? (raw as Input) : {}
  const scope = await resolveCloudScope(text(input, "projectPath") ?? "", workspaces)
  const project = { projectPath: scope.projectPath, taskId: text(input, "taskId") }
  const database = getDatabase(project.projectPath, project.taskId)
  const name = database ? (database.projectName ?? database.projectRef ?? database.url) : ""
  const describe = (
    summary: string,
    extra: { project?: string; environment?: string; statements?: Statement[]; approved?: Input } = {},
  ) => ({
    ok: true,
    scope: {
      provider: "Supabase",
      project: extra.project ?? name,
      environment: extra.environment ?? "production",
      summary,
    },
    statements: extra.statements,
    approved: extra.approved,
  })
  try {
    // A file in the repository, not the cloud account: the agent asks for it
    // under its edit permission, so plan mode and edit rules still apply.
    if (command === "create_migration") {
      const planned = await plannedMigration(scope.directory, required(input, "name"))
      const down = text(input, "downSql")
      return {
        ok: true,
        files: down ? [planned.file, planned.downFile] : [planned.file],
        statements: [
          statement(`Migration ${planned.file}`, text(input, "sql") ?? ""),
          ...(down ? [statement(`Down migration ${planned.downFile}, which rollback_migration runs`, down)] : []),
        ],
        approved: { version: planned.version },
      }
    }
    if (command === "link_database") {
      const ref = required(input, "projectRef")
      const replaces = database && database.projectRef !== ref ? ` This replaces the link to ${name}.` : ""
      return describe(
        `Link the Supabase project ${ref} to this repository and write its public URL and publishable key to .env.${replaces}`,
        { project: ref },
      )
    }
    if (command === "create_organization") {
      const organization = supabaseOrganizationName(required(input, "organizationName"))
      return describe(
        `Create a Supabase organization named ${organization} on the connected Supabase account. Projects created in it are billed to it.`,
        { project: `organization ${organization}`, environment: "account" },
      )
    }
    if (command === "create_project") {
      return describe(
        `Create a new Supabase project${text(input, "organizationId") ? ` in organization ${text(input, "organizationId")}` : ""} in ${text(input, "region") ?? "us-east-1"}. Supabase bills it to that organization.`,
        { project: "a new project" },
      )
    }
    if (!database) {
      return {
        ok: false,
        needsSetup: true,
        error: "No Supabase project is linked to this project.",
        nextStep:
          "Create one with create_database, or link an existing project with link_database (supabase_projects lists them).",
      }
    }
    if (command === "unlink_database") {
      return describe(`Unlink ${name} from this repository. The Supabase project itself is not changed.`)
    }
    if (command === "pause_database") {
      return describe(`Pause ${name}. The live app loses its database, auth and storage until it is restored.`)
    }
    if (command === "restore_database") {
      return describe(`Restore the paused project ${name}. Supabase bills its organization while it runs.`)
    }
    if (command === "write_database_url") {
      return describe(
        `Write a server-only DATABASE_URL for ${name} (transaction pooler) to this project's environment and .env. It contains the database password; its value is never shown.`,
      )
    }
    if (command === "rotate_database_password") {
      const vercel = bool(input, "syncVercel")
        ? getCloudProviderProjectLink(scope.projectPath, undefined, "vercel")
        : undefined
      return describe(
        [
          `Reset the database password of ${name}; anything still using the old password stops working.`,
          bool(input, "writeDatabaseUrl") ? "Write the new DATABASE_URL to this project's environment." : "",
          vercel
            ? `Push this project's environment to the Vercel project ${vercel.projectName} (production, preview and development).`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      )
    }
    if (command === "apply_migrations") {
      return describe(`Apply this project's pending migrations to ${name}. This changes its live database.`)
    }
    if (command === "rollback_migration") {
      const plan = await rollbackPlan(await supabaseContext(project, options), {
        directory: scope.directory,
        name: text(input, "name"),
      })
      if (!plan.ok) return plan
      return describe(
        `Roll back ${plan.last.name}, the most recently applied migration on ${name}, by running ${plan.down.source === "file" ? plan.downFile : `the -- down section of ${plan.last.name}`}. This changes the live database.`,
        {
          statements: [statement(`Down migration ${plan.downFile}`, plan.down.sql)],
          approved: { name: plan.last.name, downChecksum: plan.downChecksum },
        },
      )
    }
    if (command === "run_sql") {
      // Every query asks: one approval must not let later queries read
      // whatever they like, and the prompt shows the statement itself.
      const sql = required(input, "sql")
      const write = bool(input, "write") === true
      const schemas = Array.from(new Set(Array.from(sql.matchAll(SENSITIVE_SCHEMA), (match) => match[1].toLowerCase())))
      return describe(
        [
          write
            ? `Run SQL that can change data in ${name}, the live database.`
            : `Run a read-only SQL query against ${name}; the rows come back to the agent.`,
          schemas.length
            ? `It uses the ${schemas.join(", ")} schema${schemas.length === 1 ? "" : "s"}, where Supabase keeps users' sign-in data and secrets.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        { statements: [statement(write ? "SQL that can change data" : "Read-only SQL", sql)] },
      )
    }
    if (command === "update_auth") {
      // The exact addresses are named, since each one becomes a place sign-in
      // may send a user's session.
      const vercel = bool(input, "addVercelUrls")
        ? (await vercelRedirectSuggestions(scope.projectPath, options.request)).redirectUrls
        : []
      const providers = AUTH_PROVIDERS.flatMap((provider) => {
        const change =
          input.providers && typeof input.providers === "object" ? (input.providers as Input)[provider] : undefined
        if (!change || typeof change !== "object") return []
        return [{ provider, enabled: bool(change as Input, "enabled"), clientId: text(change as Input, "clientId") }]
      })
      const redirects = [...(list(input, "redirectUrls") ?? []), ...vercel]
      const parts = [
        text(input, "siteUrl") ? `set the site URL to ${text(input, "siteUrl")}` : "",
        redirects.length ? `allow redirects to ${redirects.join(", ")}` : "",
        bool(input, "addVercelUrls") && !vercel.length ? "allow the linked Vercel addresses (none found yet)" : "",
        list(input, "removeRedirectUrls")?.length
          ? `stop allowing ${list(input, "removeRedirectUrls")?.join(", ")}`
          : "",
        bool(input, "emailEnabled") !== undefined
          ? `turn email sign-in ${bool(input, "emailEnabled") ? "on" : "off"}`
          : "",
        ...providers.map((item) =>
          [
            item.enabled === undefined
              ? `update ${item.provider} sign-in`
              : `turn ${item.provider} sign-in ${item.enabled ? "on" : "off"}`,
            item.clientId ? `with the client id ${item.clientId}` : "",
          ]
            .filter(Boolean)
            .join(" "),
        ),
      ].filter(Boolean)
      return describe(`Change Supabase Auth on ${name}: ${parts.join("; ") || "no changes"}.`)
    }
    if (command === "invite_user") {
      return describe(`Send a sign-up invitation email to ${required(input, "email")} from ${name}.`)
    }
    if (command === "delete_user") {
      const userId = required(input, "userId")
      const email = await authUserEmail(await supabaseContext(project, options), userId)
      return describe(`Delete the user ${email ? `${email} (${userId})` : userId} from ${name}. This cannot be undone.`)
    }
    if (command === "create_bucket") {
      const visibility = bool(input, "public") ? "public" : "private"
      const limits = bucketLimits(input)
      return describe(
        `Create a ${visibility} storage bucket ${required(input, "bucket")} in ${name}${limits.length ? ` (${limits.join("; ")})` : ""}.`,
      )
    }
    if (command === "update_bucket") {
      const visibility = bool(input, "public")
      const changes = [
        visibility === undefined
          ? ""
          : visibility
            ? "make it public, so anyone with a file's URL can read it"
            : "make it private",
        ...bucketLimits(input),
      ].filter(Boolean)
      return describe(
        `Change the storage bucket ${required(input, "bucket")} in ${name}: ${changes.join("; ") || "no changes"}.`,
      )
    }
    if (command === "delete_bucket") {
      return describe(
        `Delete the storage bucket ${required(input, "bucket")} from ${name}${bool(input, "empty") ? ", and every file in it first" : ""}. This cannot be undone.`,
      )
    }
    if (command === "deploy_function") {
      const functionName = required(input, "functionName")
      const verified = await verifyJwt(scope.directory, functionName)
      return describe(
        `Deploy supabase/functions/${functionName} to ${name} as a live Edge Function.${verified ? "" : ` supabase/config.toml sets verify_jwt = false for it, so anyone on the internet can call it.`}`,
      )
    }
    if (command === "delete_function") {
      return describe(`Delete the Edge Function ${required(input, "functionName")} from ${name}.`)
    }
    if (command === "set_function_secrets") {
      const names = list(input, "secretNames") ?? []
      const missing = names.filter((key) => !listEnv(scope.projectPath).some((item) => item.key === key))
      if (missing.length) {
        return {
          ok: false,
          needsSetup: true,
          error: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in this project's environment.`,
          nextStep:
            "Ask the user to add the value in Vector Cloud > Environment variables or Edge functions; never ask for it in chat.",
        }
      }
      // A credential leaves Vector for Supabase, so each set asks.
      return describe(
        `Set the Edge Function secrets ${names.join(", ")} on ${name} from this project's stored environment. Their values are never shown.`,
      )
    }
    if (command === "delete_function_secrets") {
      return describe(`Delete the Edge Function secrets ${(list(input, "secretNames") ?? []).join(", ")} from ${name}.`)
    }
    return { ok: false, error: `${command} does not change anything, so it needs no approval.` }
  } catch (error) {
    if (error instanceof SupabaseSetupError) {
      return { ok: false, needsSetup: true, error: error.message, nextStep: error.nextStep }
    }
    return { ok: false, error: errorMessage(error) }
  }
}

// Supabase keeps sign-in data and secrets in these schemas.
const SENSITIVE_SCHEMA = /\b(auth|vault|pgsodium|storage)\s*\.\s*[a-z_"]/gi
// Enough to read in a prompt; the character count says when there is more.

type Statement = { label: string; sql: string; length: number; truncated: boolean }

function statement(label: string, sql: string): Statement {
  const trimmed = sql.trim()
  return {
    label,
    sql: trimmed,
    length: trimmed.length,
    truncated: false,
  }
}

function bucketLimits(input: Input) {
  const size = input.fileSizeLimit === null ? null : num(input, "fileSizeLimit")
  const types = input.allowedMimeTypes === null ? null : list(input, "allowedMimeTypes")
  return [
    size === null ? "no file size limit" : size !== undefined ? `file size limit ${bytes(size)}` : "",
    types === null || types?.length === 0 ? "any file type" : types ? `only ${types.join(", ")} files` : "",
  ].filter(Boolean)
}

function bytes(value: number) {
  if (value >= 1024 * 1024 && value % (1024 * 1024) === 0) return `${value / (1024 * 1024)} MB`
  if (value >= 1024 && value % 1024 === 0) return `${value / 1024} KB`
  return `${value.toLocaleString("en-US")} bytes`
}
