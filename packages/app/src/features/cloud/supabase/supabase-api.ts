// Renderer handle for the desktop's Supabase commands — the same commands the
// agent runs through vector_cloud, so the console and the agent can always do
// the same things. Every call answers with a report; nothing secret is in one.

export type SupabaseReport = { ok: boolean; error?: string; needsSetup?: boolean; nextStep?: string }

export type SupabaseOrganization = { id: string; name: string; plan?: string }
export type SupabaseProject = { ref: string; name: string; organizationId?: string; region?: string; status?: string }
export type SupabaseRegion = { id: string; label: string }

export type SupabaseProjects = {
  organizations: SupabaseOrganization[]
  projects: SupabaseProject[]
  linked: { ref: string; name: string } | null
  pending: { projectRef: string; projectName: string; region: string; organizationId: string; createdAt: string } | null
  regions: SupabaseRegion[]
}

export type SupabaseProgress = {
  stage: "checking" | "creating" | "waiting" | "linking"
  message: string
  projectRef?: string
  status?: string
  projectPath: string
}

export type MigrationState = {
  migrations?: {
    directory?: string
    projectRef?: string
    discovered: string[]
    skipped: string[]
    alreadyApplied: string[]
    appliedByCli: string[]
    changed: string[]
    pending: string[]
    applied: string[]
    failed?: { name: string; error: string }
  }
  rollback?: { name: string; available: boolean; source?: "file" | "section" }
}

export type SqlResult = {
  columns: string[]
  rows: (string | number | boolean | null)[][]
  rowCount: number
  truncated: boolean
  readOnly: boolean
}

export type AuthProviderName = "google" | "github" | "apple"

export type AuthSettings = {
  siteUrl?: string
  redirectUrls: string[]
  email: { enabled: boolean; signupDisabled: boolean }
  providers: Record<AuthProviderName, { enabled: boolean; clientId?: string; secretSet: boolean }>
}

export type AuthUser = {
  id: string
  email?: string
  phone?: string
  createdAt?: string
  lastSignInAt?: string
  confirmed: boolean
  providers: string[]
}

export type StorageBucket = {
  id: string
  name: string
  public: boolean
  fileSizeLimit?: number
  allowedMimeTypes?: string[]
  updatedAt?: string
}

export type DeployedFunction = { id: string; slug: string; name: string; status?: string; version?: number; updatedAt?: string }

export type FunctionSecret = { name: string; updatedAt?: string; reserved: boolean }

export type LogService = "api" | "postgres" | "auth" | "storage" | "functions"

export type SecurityFinding = { where: string; reason: string; level: "ERROR" | "WARN" }

export type SecurityReport = {
  status: "passed" | "failed" | "skipped"
  advisors: { name: string; title: string; level: "ERROR" | "WARN" | "INFO"; detail?: string; remediation?: string; entity?: string }[]
  advisorsError?: string
  environment: SecurityFinding[]
  bundle: SecurityFinding[]
  errors: number
  warnings: number
  checkedAt: string
  detail: string
}

export type SupabaseBridge = {
  run: (command: string, input: Record<string, unknown>) => Promise<SupabaseReport & Record<string, unknown>>
  subscribe: (cb: (event: SupabaseProgress) => void) => () => void
}

function desktopBridge(): SupabaseBridge | undefined {
  const api = globalThis.window?.api as (Record<string, unknown> & { cloud?: { supabase?: SupabaseBridge } }) | undefined
  return api?.cloud?.supabase
}

// The scope every command runs in: the open project (an agent worktree
// resolves to its project on the desktop side).
export function supabaseClient(
  scope: () => { projectPath: string; taskId?: string },
  bridge: () => SupabaseBridge | undefined = desktopBridge,
) {
  const run = async <T extends object>(command: string, input: Record<string, unknown> = {}) => {
    const api = bridge()
    if (!api) return { ok: false, error: "Supabase controls run in the Vector desktop app." } as SupabaseReport & Partial<T>
    return (await api.run(command, { ...scope(), ...input }).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))) as SupabaseReport & Partial<T>
  }
  return {
    subscribe: (cb: (event: SupabaseProgress) => void) => bridge()?.subscribe(cb) ?? (() => undefined),
    projects: () => run<SupabaseProjects>("supabase_projects"),
    createProject: (organizationId?: string, region?: string) =>
      run<{ createdNow: boolean; needsChoice: boolean; organizations: SupabaseOrganization[]; waitedMs: number }>(
        "create_project",
        { organizationId, region },
      ),
    link: (projectRef: string) =>
      run<{ client?: { path: string; created: boolean; dependencyMissing: boolean } }>("link_database", { projectRef }),
    unlink: () => run<{ detail: string }>("unlink_database"),
    pause: () => run<{ detail: string; project: SupabaseProject }>("pause_database"),
    restore: () => run<{ detail: string; project: SupabaseProject }>("restore_database"),
    writeDatabaseUrl: () => run<{ detail: string; replaced: boolean }>("write_database_url", { consent: true }),
    rotatePassword: (input: { writeDatabaseUrl: boolean; syncVercel: boolean }) =>
      run<{ detail: string; databaseUrl: string; problems: string[]; vercel: { synced: boolean; detail?: string } }>(
        "rotate_database_password",
        input,
      ),
    migrationStatus: () => run<MigrationState>("migration_status"),
    applyMigrations: () => run<MigrationState>("apply_migrations"),
    rollback: (name: string) => run<{ rolledBack: string; nextStep: string }>("rollback_migration", { name }),
    runSql: (sql: string, write = false) => run<{ result: SqlResult; needsConfirmation: boolean }>("run_sql", { sql, write }),
    auth: () => run<{ auth: AuthSettings }>("auth_config"),
    updateAuth: (input: Record<string, unknown>) => run<{ auth: AuthSettings; changed: string[] }>("update_auth", input),
    vercelRedirects: () => run<{ siteUrl?: string; redirectUrls: string[]; detail?: string }>("vercel_redirect_urls"),
    users: (page: number) => run<{ users: AuthUser[]; hasMore: boolean; page: number }>("auth_users", { page }),
    inviteUser: (email: string) => run<{ detail: string }>("invite_user", { email }),
    deleteUser: (userId: string) => run<{ detail: string }>("delete_user", { userId }),
    buckets: () => run<{ buckets: StorageBucket[] }>("buckets"),
    createBucket: (input: { bucket: string; public: boolean; fileSizeLimit?: number; allowedMimeTypes?: string[] }) =>
      run<{ detail: string }>("create_bucket", input),
    updateBucket: (input: { bucket: string; public?: boolean; fileSizeLimit?: number | null; allowedMimeTypes?: string[] | null }) =>
      run<{ detail: string }>("update_bucket", input),
    deleteBucket: (bucket: string, empty: boolean) => run<{ detail: string }>("delete_bucket", { bucket, empty }),
    functions: () => run<{ deployed: DeployedFunction[]; local: string[] }>("functions"),
    deployFunction: (functionName: string) => run<{ detail: string; url: string }>("deploy_function", { functionName }),
    deleteFunction: (functionName: string) => run<{ detail: string }>("delete_function", { functionName }),
    secrets: () => run<{ secrets: FunctionSecret[] }>("function_secrets"),
    setSecret: (name: string, value: string) =>
      run<{ detail: string }>("set_function_secrets", { secrets: [{ name, value }] }),
    deleteSecret: (name: string) => run<{ detail: string }>("delete_function_secrets", { secretNames: [name] }),
    logs: (input: { service: LogService; minutes: number; search?: string }) =>
      run<{ label: string; entries: { at: string; message: string }[]; truncated: boolean }>("supabase_logs", input),
    security: () => run<{ security: SecurityReport }>("security_check"),
  }
}

export type SupabaseClient = ReturnType<typeof supabaseClient>
