import { randomBytes } from "node:crypto"

import { applyEnv, cloudProjectScopeKey, listEnv, setEnv } from "./cloud-console"
import { getCloudProviderProjectLink, syncCloudProviderEnvironment } from "./cloud-connections"
import { decryptCloudCredential, encryptCloudCredential } from "./cloud-credential-vault"
import { provisionedPassword } from "./cloud-provision"
import { ensureEnvIgnored } from "./cloud-supabase-env"
import {
  management,
  numberField,
  refPath,
  responseArray,
  stringField,
  SupabaseSetupError,
  type SupabaseContext,
} from "./cloud-supabase-api"
import { getStore } from "./store"

// Server-side access to the linked database: a DATABASE_URL for ORMs and
// migration tools, and rotating the database password. The password is only
// ever held encrypted at rest and is never part of a result.

const PASSWORD_STORE = "cloud-supabase-database"
const DATABASE_URL = "DATABASE_URL"

type PasswordRecord = { projectRef: string; password: string; rotatedAt: string }

function readPasswordRecord(projectPath: string): PasswordRecord | undefined {
  const raw = getStore(PASSWORD_STORE).get(cloudProjectScopeKey(projectPath))
  const projectRef = stringField(raw, "projectRef")
  const password = stringField(raw, "password")
  if (!projectRef || !password) return
  return { projectRef, password, rotatedAt: stringField(raw, "rotatedAt") ?? "" }
}

// The password Vector set last for this project: a rotation, or the one it
// generated when it created the project. A project linked from elsewhere has
// none until it is rotated here.
function databasePassword(context: SupabaseContext): string | undefined {
  const record = readPasswordRecord(context.projectPath)
  const encrypted =
    record?.projectRef === context.projectRef ? record.password : provisionedPassword(context.projectPath, context.projectRef)
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
// never inlines a name without a public prefix), and never shown back.
export async function writeDatabaseUrl(context: SupabaseContext, input: { directory: string; consent?: boolean }) {
  if (input.consent !== true) {
    throw new SupabaseSetupError(
      "Writing DATABASE_URL needs the user's explicit consent, because it contains the database password.",
      "Ask the user whether to write a server-only DATABASE_URL for this project, then run the action again with their consent.",
    )
  }
  const password = databasePassword(context)
  if (!password) {
    throw new SupabaseSetupError(
      `Vector does not know the database password of ${context.projectName}, because the project was not created or rotated here.`,
      "Rotate the database password (rotate_database_password, or Cloud Services > Database), which can write DATABASE_URL at the same time. Anything else using the old password stops working.",
    )
  }
  const pooler = await transactionPoolerUrl(context, password)
  const replaced = listEnv(context.projectPath).some((item) => item.key === DATABASE_URL)
  setEnv(context.projectPath, context.taskId, DATABASE_URL, pooler.url, "server")
  const ignored = await ensureEnvIgnored(input.directory)
  await applyEnv(context.projectPath, context.taskId, input.directory)
  return {
    variable: { key: DATABASE_URL, visibility: "server" as const, host: pooler.host, port: pooler.port, mode: "transaction" },
    replaced,
    gitignoreUpdated: ignored.added,
    detail: `DATABASE_URL now points at ${context.projectName} through the transaction pooler. It is server-only and written to .env; its value is never shown.`,
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
  getStore(PASSWORD_STORE).set(cloudProjectScopeKey(context.projectPath), {
    projectRef: context.projectRef,
    password: encryptCloudCredential(password),
    rotatedAt: new Date().toISOString(),
  } satisfies PasswordRecord)

  // A DATABASE_URL that already points at this project would now fail, so it
  // follows the new password; one for another database is left alone.
  const current = listEnv(context.projectPath).find((item) => item.key === DATABASE_URL)
  const follows = Boolean(current?.value.includes(context.projectRef))
  const databaseUrl =
    follows || input.writeDatabaseUrl === true
      ? await writeDatabaseUrl(context, { directory: input.directory, consent: true }).then(() =>
          follows ? ("updated" as const) : ("written" as const),
        )
      : ("unchanged" as const)

  const link = getCloudProviderProjectLink(context.projectPath, context.taskId, "vercel")
  const vercel =
    input.syncVercel === true && databaseUrl !== "unchanged" && link
      ? await syncCloudProviderEnvironment(context.projectPath, context.taskId, "vercel", context.request).then(
          (result) => ({ synced: true, projectName: result.projectName, changed: result.changed }),
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
  return {
    rotated: true,
    databaseUrl,
    vercel,
    detail: `The database password of ${context.projectName} was reset and saved encrypted in Vector.${
      databaseUrl === "unchanged" ? " Anything that used the old password must be updated." : ""
    }${vercel.synced ? " Redeploy on Vercel for the new value to take effect." : ""}`,
  }
}
