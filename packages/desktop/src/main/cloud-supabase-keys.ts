import { randomBytes } from "node:crypto"

import { applyEnv, cloudProjectScopeKey, listEnv, setEnv } from "./cloud-console"
import { getCloudProviderProjectLink } from "./cloud-connections"
import { decryptCloudCredential, encryptCloudCredential } from "./cloud-credential-vault"
import { provisionedPassword } from "./cloud-provision"
import { ensureEnvIgnored, envTracked } from "./cloud-supabase-env"
import {
  errorMessage,
  management,
  numberField,
  refPath,
  responseArray,
  scrub,
  stringField,
  SupabaseSetupError,
  type SupabaseContext,
} from "./cloud-supabase-api"
import { listVercelEnv, setVercelEnv, VERCEL_ENV_TARGETS } from "./cloud-vercel-env"
import { getStore } from "./store"

// Server-side access to the linked database: a DATABASE_URL for ORMs and
// migration tools, and rotating the database password. The password is only
// ever held encrypted at rest and is never part of a result.

const PASSWORD_STORE = "cloud-supabase-database"
const DATABASE_URL = "DATABASE_URL"

type PasswordRecord = { projectRef: string; password: string; savedAt: string }

function readPasswordRecord(projectPath: string): PasswordRecord | undefined {
  const raw = getStore(PASSWORD_STORE).get(cloudProjectScopeKey(projectPath))
  const projectRef = stringField(raw, "projectRef")
  const password = stringField(raw, "password")
  if (!projectRef || !password) return
  return { projectRef, password, savedAt: stringField(raw, "savedAt") ?? "" }
}

function savePassword(context: SupabaseContext, password: string) {
  getStore(PASSWORD_STORE).set(cloudProjectScopeKey(context.projectPath), {
    projectRef: context.projectRef,
    password: encryptCloudCredential(password),
    savedAt: new Date().toISOString(),
  } satisfies PasswordRecord)
}

// The password Vector knows for this project: one the user entered, a
// rotation, or the one it generated when it created the project. A project
// linked from elsewhere has none until the user enters it or rotates it here.
function databasePassword(context: SupabaseContext): string | undefined {
  const record = readPasswordRecord(context.projectPath)
  const encrypted =
    record?.projectRef === context.projectRef
      ? record.password
      : provisionedPassword(context.projectPath, context.projectRef)
  if (!encrypted) return
  const password = decryptCloudCredential(encrypted)
  context.secrets.push(password)
  return password
}

// Transaction mode (Supavisor, port 6543) suits serverless functions that open
// a connection per request: https://supabase.com/docs/guides/database/connecting-to-postgres#supavisor-transaction-mode
// https://supabase.com/docs/reference/api/v1-get-pooler-config
async function transactionPoolerUrl(context: SupabaseContext, password: string) {
  const configs = responseArray(await management(context, refPath(context, "/config/database/pooler")))
  const primary = configs.filter((item) => (stringField(item, "database_type") ?? "PRIMARY") === "PRIMARY")
  const config = primary.find((item) => stringField(item, "pool_mode") === "transaction") ?? primary[0]
  const user = stringField(config, "db_user") ?? `postgres.${context.projectRef}`
  const host = stringField(config, "db_host")
  if (!host) throw new Error(`Supabase did not report a connection pooler for ${context.projectName}.`)
  const port = stringField(config, "pool_mode") === "transaction" ? (numberField(config, "db_port") ?? 6543) : 6543
  const database = stringField(config, "db_name") ?? "postgres"
  return {
    url: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`,
    host,
    port,
  }
}

// A DATABASE_URL carries the database password, so it is written only when the
// user said yes to exactly that, only as a server-only variable (a bundler
// never inlines a name without a public prefix), only into a .env git does not
// track, and never shown back. `password` is the current one, typed by the user
// in the console for a project Vector did not create; the agent never sends it.
export async function writeDatabaseUrl(
  context: SupabaseContext,
  input: { directory: string; consent?: boolean; password?: string },
) {
  if (input.consent !== true) {
    throw new SupabaseSetupError(
      "Writing DATABASE_URL needs the user's explicit consent, because it contains the database password.",
      "Ask the user whether to write a server-only DATABASE_URL for this project, then run the action again with their consent.",
    )
  }
  if (input.password) context.secrets.push(input.password)
  const password = input.password ?? databasePassword(context)
  if (!password) {
    throw new SupabaseSetupError(
      `Vector does not know the database password of ${context.projectName}, because the project was not created or rotated here.`,
      "Ask the user to enter the current database password in Vector Cloud > Database, where Vector keeps it encrypted. Rotating it instead (rotate_database_password) breaks anything still using the old one.",
    )
  }
  if (await envTracked(input.directory)) {
    throw new SupabaseSetupError(
      "Vector did not write DATABASE_URL, because this repository's .env is committed to git and the URL holds the database password.",
      "Stop tracking it with `git rm --cached .env` (the file stays on disk), commit that, then write DATABASE_URL again.",
    )
  }
  const pooler = await transactionPoolerUrl(context, password)
  if (input.password) savePassword(context, input.password)
  const replaced = listEnv(context.projectPath).some((item) => item.key === DATABASE_URL)
  setEnv(context.projectPath, context.taskId, DATABASE_URL, pooler.url, "server")
  const ignored = await ensureEnvIgnored(input.directory)
  await applyEnv(context.projectPath, context.taskId, input.directory)
  return {
    variable: {
      key: DATABASE_URL,
      visibility: "server" as const,
      host: pooler.host,
      port: pooler.port,
      mode: "transaction",
    },
    replaced,
    gitignoreUpdated: ignored.added,
    detail: `DATABASE_URL now points at ${context.projectName} through the transaction pooler. It is server-only and written to .env; its value is never shown.${input.password ? " Vector cannot check the password itself, so a wrong one shows up as a failed sign-in when the app connects." : ""}`,
  }
}

// https://supabase.com/docs/reference/api/v1-update-database-password
export async function rotateDatabasePassword(
  context: SupabaseContext,
  input: { directory: string; writeDatabaseUrl?: boolean; syncVercel?: boolean },
) {
  // base64url so nothing in it needs escaping inside a connection string.
  const password = randomBytes(24).toString("base64url")
  context.secrets.push(password)
  await management(context, refPath(context, "/database/password"), { method: "PATCH", json: { password } })
  savePassword(context, password)

  // A DATABASE_URL that already points at this project would now fail, so it
  // follows the new password; one for another database is left alone.
  // From here on the password has changed, so a later step that fails is
  // reported next to that fact instead of hiding it behind an error.
  const current = listEnv(context.projectPath).find((item) => item.key === DATABASE_URL)
  const follows = Boolean(current?.value.includes(context.projectRef))
  const problems: string[] = []
  const databaseUrl =
    follows || input.writeDatabaseUrl === true
      ? await writeDatabaseUrl(context, { directory: input.directory, consent: true }).then(
          () => (follows ? ("updated" as const) : ("written" as const)),
          (error: unknown) => {
            problems.push(`DATABASE_URL was not updated: ${scrub(context, errorMessage(error))}`)
            return "failed" as const
          },
        )
      : ("unchanged" as const)

  const link = getCloudProviderProjectLink(context.projectPath, context.taskId, "vercel")
  const vercel =
    input.syncVercel === true && (databaseUrl === "written" || databaseUrl === "updated") && link
      ? await pushDatabaseUrl(context).then(
          (result) => ({ synced: true, projectName: result.project, changed: result.changed, detail: undefined }),
          (error: unknown) => ({
            synced: false,
            detail: `Vercel was not updated: ${scrub(context, errorMessage(error))}`,
          }),
        )
      : {
          synced: false,
          detail:
            input.syncVercel !== true
              ? "Vercel was not asked to update."
              : !link
                ? "No Vercel project is linked."
                : "No DATABASE_URL to update on Vercel.",
        }
  if (input.syncVercel === true && !vercel.synced && vercel.detail) problems.push(vercel.detail)
  return {
    rotated: true,
    databaseUrl,
    vercel,
    problems,
    detail: [
      `The database password of ${context.projectName} was reset and saved encrypted in Vector.`,
      databaseUrl === "unchanged" ? "Anything that used the old password must be updated." : "",
      vercel.synced ? "Redeploy on Vercel for the new value to take effect." : "",
      ...problems,
    ]
      .filter(Boolean)
      .join(" "),
  }
}

// The rotated DATABASE_URL replaces the value of each Vercel entry that holds
// it, for the environments that entry covers; a project without one gets it for
// every environment. Branch-specific preview values are left alone, and no
// other variable is sent.
async function pushDatabaseUrl(context: SupabaseContext) {
  const value = listEnv(context.projectPath, context.taskId).find((item) => item.key === DATABASE_URL)?.value
  if (!value) throw new Error("DATABASE_URL is not stored in Vector.")
  const remote = await listVercelEnv(context.projectPath, { request: context.request })
  const entries = remote.variables.filter((item) => item.key === DATABASE_URL && !item.gitBranch)
  const targets = entries.length ? entries.map((item) => item.targets) : [[...VERCEL_ENV_TARGETS]]
  await Promise.all(
    targets.map((target) =>
      setVercelEnv(context.projectPath, { key: DATABASE_URL, value, targets: target }, { request: context.request }),
    ),
  )
  return { project: remote.project, changed: targets.length }
}
