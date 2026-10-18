import { connectDatabase, disconnectDatabase, getDatabase } from "./cloud-console"
import { createCloudDatabase, pendingProvision, type CloudProvisionProgress } from "./cloud-provision"
import { scaffoldSupabaseClient, supabaseEnvNote, supabaseFramework } from "./cloud-supabase-env"
import {
  management,
  managementToken,
  refPath,
  responseArray,
  stringField,
  SupabaseApiError,
  SupabaseSetupError,
  type SupabaseContext,
  type SupabaseOptions,
} from "./cloud-supabase-api"

// Supabase projects as a repository sees them: the account's organizations and
// projects to choose from, creating one (the same path the agent's
// create_database takes, with its billing rules), linking and unlinking, and
// pausing or restoring the linked one.

export type SupabaseOrganizationSummary = { id: string; name: string; plan?: string }

export type SupabaseProjectSummary = {
  ref: string
  name: string
  organizationId?: string
  region?: string
  status?: string
  createdAt?: string
}

// Supabase's hosted regions: https://supabase.com/docs/guides/platform/regions
export const SUPABASE_REGIONS = [
  { id: "us-east-1", label: "East US (North Virginia)" },
  { id: "us-east-2", label: "East US (Ohio)" },
  { id: "us-west-1", label: "West US (North California)" },
  { id: "us-west-2", label: "West US (Oregon)" },
  { id: "ca-central-1", label: "Canada (Central)" },
  { id: "eu-west-1", label: "West EU (Ireland)" },
  { id: "eu-west-2", label: "West Europe (London)" },
  { id: "eu-west-3", label: "West EU (Paris)" },
  { id: "eu-central-1", label: "Central EU (Frankfurt)" },
  { id: "eu-central-2", label: "Central Europe (Zurich)" },
  { id: "eu-north-1", label: "North EU (Stockholm)" },
  { id: "ap-south-1", label: "South Asia (Mumbai)" },
  { id: "ap-southeast-1", label: "Southeast Asia (Singapore)" },
  { id: "ap-northeast-1", label: "Northeast Asia (Tokyo)" },
  { id: "ap-northeast-2", label: "Northeast Asia (Seoul)" },
  { id: "ap-southeast-2", label: "Oceania (Sydney)" },
  { id: "sa-east-1", label: "South America (São Paulo)" },
] as const

const PROJECT_REF = /^[a-z0-9][a-z0-9-]{2,62}$/

// Listing needs only the account connection, not a linked project.
async function accountContext(options: SupabaseOptions): Promise<SupabaseContext> {
  const token = await managementToken(options)
  return {
    projectPath: "",
    projectRef: "",
    projectName: "",
    projectUrl: "",
    token,
    request: options.request ?? fetch,
    secrets: [token],
  }
}

export async function listSupabaseProjects(
  input: { projectPath: string; taskId?: string },
  options: SupabaseOptions = {},
) {
  const context = await accountContext(options)
  const [organizations, projects] = await Promise.all([
    management(context, "/organizations"),
    management(context, "/projects"),
  ])
  const linked = getDatabase(input.projectPath, input.taskId)
  return {
    organizations: responseArray(organizations)
      .map((item): SupabaseOrganizationSummary | undefined => {
        const id = stringField(item, "id") ?? stringField(item, "slug")
        if (!id) return
        return {
          id,
          name: stringField(item, "name") ?? id,
          plan: stringField(item, "plan") ?? stringField(item, "tier"),
        }
      })
      .filter((item): item is SupabaseOrganizationSummary => Boolean(item)),
    projects: responseArray(projects)
      .map(summarizeProject)
      .filter((item): item is SupabaseProjectSummary => Boolean(item)),
    linked: linked?.projectRef ? { ref: linked.projectRef, name: linked.projectName ?? linked.projectRef } : null,
    pending: pendingProvision(input.projectPath) ?? null,
    regions: SUPABASE_REGIONS,
  }
}

function summarizeProject(item: unknown): SupabaseProjectSummary | undefined {
  const ref = stringField(item, "ref") ?? stringField(item, "id")
  const name = stringField(item, "name")
  if (!ref || !name) return
  return {
    ref,
    name,
    organizationId: stringField(item, "organization_id") ?? stringField(item, "organization_slug"),
    region: stringField(item, "region"),
    status: stringField(item, "status"),
    createdAt: stringField(item, "created_at"),
  }
}

// An account with no organization has nowhere to create a project, so Vector
// creates the organization itself instead of sending the user to Supabase's
// dashboard. It is the call the Supabase command-line tool's `orgs create`
// makes: https://supabase.com/docs/reference/api/v1-create-an-organization.
// A retry after an interruption finds the organization by its exact name
// instead of creating a second one.
export async function createSupabaseOrganization(input: { name: string }, options: SupabaseOptions = {}) {
  const name = supabaseOrganizationName(input.name)
  const context = await accountContext(options)
  const existing = responseArray(await management(context, "/organizations")).find(
    (item) => stringField(item, "name") === name,
  )
  const created = existing ?? (await management(context, "/organizations", { method: "POST", json: { name } }))
  const id = stringField(created, "id") ?? stringField(created, "slug")
  if (!id) throw new Error("Supabase did not return the new organization.")
  return {
    organization: { id, name: stringField(created, "name") ?? name, plan: stringField(created, "plan") },
    createdNow: !existing,
    detail: existing
      ? `The Supabase organization ${name} already exists, so Vector did not create another.`
      : `Created the Supabase organization ${name}.`,
  }
}

// Checked before the permission prompt shows the name and again before it is sent.
export function supabaseOrganizationName(value: string) {
  const name = value.trim()
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Name the organization with up to 100 characters on one line.")
  }
  return name
}

// The same creation the agent's create_database runs: one organization chosen
// by the user, a project that resumes instead of duplicating after an
// interruption, and Supabase's own words for a plan or quota refusal.
export function createSupabaseProject(
  input: { projectPath: string; taskId?: string; directory: string; organizationId?: string; region?: string },
  options: SupabaseOptions & { progress?: (event: CloudProvisionProgress) => void } = {},
) {
  return createCloudDatabase(
    {
      projectPath: input.projectPath,
      taskId: input.taskId,
      directory: input.directory,
      organizationId: input.organizationId,
      region: input.region,
    },
    { request: options.request, progress: options.progress },
  )
}

// https://supabase.com/docs/reference/api/v1-get-project and v1-get-project-api-keys
export async function linkSupabaseProject(
  input: { projectPath: string; taskId?: string; directory: string; projectRef: string },
  options: SupabaseOptions = {},
) {
  const projectRef = input.projectRef.trim()
  if (!PROJECT_REF.test(projectRef)) throw new Error("Choose a Supabase project from the list.")
  const context = { ...(await accountContext(options)), projectPath: input.projectPath, taskId: input.taskId }
  const project = await management(context, `/projects/${encodeURIComponent(projectRef)}`).catch((error) => {
    if (error instanceof SupabaseApiError && error.status === 404) {
      throw new Error("That Supabase project is not on the connected account any more.")
    }
    throw error
  })
  const keys = responseArray(await management(context, `/projects/${encodeURIComponent(projectRef)}/api-keys`))
  const publicKey =
    keys.find((item) => stringField(item, "type") === "publishable") ??
    keys.find((item) => stringField(item, "name") === "anon") ??
    keys.find((item) => stringField(item, "type") === "anon")
  const anonKey = stringField(publicKey, "api_key")
  if (!anonKey) throw new Error("Supabase did not expose a publishable or anon key for this Supabase project.")
  const connection = await connectDatabase(
    input.projectPath,
    input.taskId,
    {
      provider: "supabase",
      url: `https://${projectRef}.supabase.co`,
      anonKey,
      projectRef,
      projectName: stringField(project, "name") ?? projectRef,
      managedByOAuth: true,
    },
    input.directory,
  )
  const framework = await supabaseFramework(input.directory)
  const client = await scaffoldSupabaseClient(input.directory, framework).catch(() => undefined)
  return {
    database: connection ? { ref: projectRef, name: connection.projectName ?? projectRef } : null,
    client,
    nextStep:
      [
        client?.dependencyMissing
          ? "Install @supabase/supabase-js in this repository so the generated client can import it."
          : "",
        supabaseEnvNote(framework) ?? "",
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  }
}

export function unlinkSupabaseProject(input: { projectPath: string; taskId?: string }) {
  const database = getDatabase(input.projectPath, input.taskId)
  if (!database) throw new SupabaseSetupError("No Supabase project is linked to this repository.", "Nothing to unlink.")
  disconnectDatabase(input.projectPath, input.taskId)
  return {
    unlinked: { ref: database.projectRef, name: database.projectName ?? database.projectRef },
    detail:
      "The Supabase project is no longer linked. Its values in .env were left in place and the Supabase project itself was not changed.",
  }
}

export async function supabaseProjectStatus(context: SupabaseContext) {
  const project = await management(context, refPath(context, ""))
  return { ref: context.projectRef, name: context.projectName, ...summarizeProject(project) }
}

// https://supabase.com/docs/reference/api/v1-pause-a-project
export async function pauseSupabaseProject(context: SupabaseContext) {
  await management(context, refPath(context, "/pause"), { method: "POST" })
  return {
    project: await supabaseProjectStatus(context),
    detail: `${context.projectName} is pausing. The app cannot reach its database, auth or storage until it is restored.`,
  }
}

// https://supabase.com/docs/reference/api/v1-restore-a-project
export async function restoreSupabaseProject(context: SupabaseContext) {
  await management(context, refPath(context, "/restore"), { method: "POST" })
  return {
    project: await supabaseProjectStatus(context),
    detail: `${context.projectName} is restoring. Supabase takes a few minutes to bring it back.`,
  }
}
