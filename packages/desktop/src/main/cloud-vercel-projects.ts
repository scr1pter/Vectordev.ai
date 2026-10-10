import { readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  cachedCloudProviderConnection,
  getCloudProviderProjectLink,
  getCloudProviderRuntimeAuth,
  saveCloudProviderProjectLink,
  setCloudProviderDefaultTeam,
  unlinkCloudProviderProject,
  type CloudProviderProjectLink,
} from "./cloud-connections"
import { decryptCloudCredential, encryptCloudCredential } from "./cloud-credential-vault"
import { getStore } from "./store"
import {
  linkTeamId,
  numberField,
  objectField,
  parseJson,
  stringField,
  vercelAuth,
  vercelLinkContext,
  vercelPages,
  vercelRequest,
  VercelError,
  type VercelAuth,
  type VercelFetch,
  type VercelLinkContext,
  type VercelScopeChoice,
} from "./cloud-vercel-api"

// Vercel accounts, teams and projects: which scope a token works in, the
// project a repository deploys to, and that project's build settings and
// Deployment Protection.

export type VercelScope = {
  /** Absent for the personal account. */
  teamId?: string
  slug: string
  name: string
  kind: "personal" | "team"
}

export type VercelProjectSummary = {
  id: string
  name: string
  accountId?: string
  framework?: string
  productionUrl?: string
  updatedAt?: string
}

// The versions new deployments can build with: Vercel turned Node.js 18 off in
// 2025 and Node.js 20 on October 1, 2026
// (https://vercel.com/docs/functions/runtimes/node-js/node-js-versions,
// https://vercel.com/changelog/node-js-20-is-being-deprecated).
export const VERCEL_NODE_VERSIONS = ["24.x", "22.x"] as const
export type VercelNodeVersion = (typeof VERCEL_NODE_VERSIONS)[number]

export type VercelProjectSettings = {
  framework: string | null
  rootDirectory: string | null
  buildCommand: string | null
  outputDirectory: string | null
  installCommand: string | null
  nodeVersion: string | null
}

export type VercelProtection = {
  /** Vercel Authentication, by deployment type ("preview", "all", ...); null when off. */
  vercelAuthentication: string | null
  passwordProtection: boolean
  /** A Protection Bypass for Automation secret exists, so Vector can check protected deployments. */
  bypassReady: boolean
}

export type VercelProjectDetails = {
  id: string
  name: string
  accountId?: string
  settings: VercelProjectSettings
  protection: VercelProtection
  productionUrl?: string
  productionDeploymentId?: string
  gitRepository?: string
}

export type VercelProjectStatus = {
  connected: boolean
  account?: string
  link?: CloudProviderProjectLink
  /** The project a .vercel/project.json names, when nothing is linked yet. */
  candidate?: VercelProjectCandidate
  project?: VercelProjectDetails
  /** Why the linked project could not be read, worded for the user. */
  error?: string
}

const BYPASS_STORE = "cloud-vercel-bypass"
const BYPASS_NOTE = "Vector release checks"
// https://vercel.com/docs/rest-api/projects/create-a-new-project (name: maxLength 100).
const PROJECT_NAME = /^(?!.*---)[a-z0-9][a-z0-9._-]{0,99}$/
const FRAMEWORK_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

// https://vercel.com/docs/rest-api/user/get-the-user and
// https://vercel.com/docs/rest-api/teams/list-all-teams, every page.
export async function listVercelScopes(request?: VercelFetch): Promise<{ scopes: VercelScope[]; selected?: string }> {
  const auth = await vercelAuth(null)
  const [userBody, teams] = await Promise.all([
    vercelRequest(auth, "/v2/user", { request, unscoped: true }),
    vercelPages(auth, "/v2/teams", "teams", { cursor: "until", request, unscoped: true }),
  ])
  const user = objectField(userBody, "user") ?? userBody
  const username = stringField(user, "username") ?? stringField(user, "email") ?? "personal"
  const runtime = await getCloudProviderRuntimeAuth("vercel")
  return {
    scopes: [
      { kind: "personal", slug: username, name: stringField(user, "name") ?? username },
      ...teams.flatMap((team): VercelScope[] => {
        const teamId = stringField(team, "id")
        const slug = stringField(team, "slug")
        if (!teamId || !slug) return []
        return [{ kind: "team", teamId, slug, name: stringField(team, "name") ?? slug }]
      }),
    ],
    selected: runtime.teamId,
  }
}

export async function selectVercelScope(teamId: string | null, request?: VercelFetch) {
  const listed = await listVercelScopes(request)
  if (teamId && !listed.scopes.some((scope) => scope.teamId === teamId)) {
    throw new VercelError("not_found", "That Vercel team is not available to the connected token.")
  }
  setCloudProviderDefaultTeam("vercel", teamId ?? undefined)
  return { ...listed, selected: teamId ?? undefined }
}

// https://vercel.com/docs/rest-api/projects/retrieve-a-list-of-projects: the
// continuation goes back as `from`.
export async function listVercelProjects(scope?: VercelScopeChoice, request?: VercelFetch) {
  const auth = await vercelAuth(scope)
  const projects = await vercelPages(auth, "/v10/projects", "projects", { cursor: "from", request })
  return projects.flatMap((project): VercelProjectSummary[] => {
    const id = stringField(project, "id")
    const name = stringField(project, "name")
    if (!id || !name) return []
    const updatedAt = numberField(project, "updatedAt")
    return [
      {
        id,
        name,
        accountId: stringField(project, "accountId"),
        framework: stringField(project, "framework"),
        productionUrl: productionUrl(project),
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : undefined,
      },
    ]
  })
}

// https://vercel.com/docs/rest-api/projects/create-a-new-project
export async function createVercelProject(
  projectPath: string,
  input: { name: string; framework?: string; rootDirectory?: string; teamId?: string | null },
  request?: VercelFetch,
) {
  const name = input.name.trim().toLowerCase()
  if (!PROJECT_NAME.test(name)) {
    throw new VercelError(
      "invalid",
      "Use a Vercel project name of up to 100 lowercase letters, digits, '.', '_' or '-', without '---'.",
    )
  }
  const framework = optionalFramework(input.framework)
  const rootDirectory = optionalRootDirectory(input.rootDirectory)
  const auth = await vercelAuth(input.teamId)
  const created = await vercelRequest(auth, "/v11/projects", {
    method: "POST",
    body: {
      name,
      ...(framework ? { framework } : {}),
      ...(rootDirectory ? { rootDirectory } : {}),
    },
    request,
  })
  return saveLink(projectPath, created, auth)
}

// https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name
export async function linkVercelProject(
  projectPath: string,
  projectId: string,
  teamId?: string | null,
  request?: VercelFetch,
) {
  if (!projectId.trim()) throw new VercelError("invalid", "Choose a Vercel project to link.")
  const auth = await vercelAuth(teamId)
  const project = await vercelRequest(auth, `/v9/projects/${encodeURIComponent(projectId.trim())}`, { request })
  return saveLink(projectPath, project, auth)
}

export async function unlinkVercelProject(projectPath: string) {
  await unlinkCloudProviderProject(projectPath, undefined, "vercel")
  return { unlinked: true }
}

export type VercelProjectCandidate = { projectId: string; teamId?: string }

// A repository the user already deployed with the Vercel CLI carries
// .vercel/project.json ({ projectId, orgId }). Cloud Services links that
// project rather than asking the user to find it again. A worktree has its own
// copy. Anything an agent can write is only a candidate there: the agent links
// with link_project, which asks the user.
export async function autoLinkVercelProject(
  projectPath: string,
  directory = projectPath,
  request?: VercelFetch,
): Promise<CloudProviderProjectLink | undefined> {
  const existing = getCloudProviderProjectLink(projectPath, undefined, "vercel")
  if (existing) return existing
  if (!cachedCloudProviderConnection("vercel").connected) return
  const candidate = await vercelProjectCandidate(projectPath, directory)
  if (!candidate) return
  const auth = await vercelAuth(candidate.teamId ?? null)
  const project = await vercelRequest(auth, `/v9/projects/${encodeURIComponent(candidate.projectId)}`, {
    request,
  }).catch(() => undefined)
  if (!project) return
  return saveLink(projectPath, project, auth, ".vercel/project.json")
}

export async function vercelProjectCandidate(projectPath: string, directory = projectPath) {
  return (
    (await readVercelProjectFile(directory)) ??
    (directory === projectPath ? undefined : await readVercelProjectFile(projectPath))
  )
}

async function readVercelProjectFile(directory: string): Promise<VercelProjectCandidate | undefined> {
  const parsed = await readFile(join(directory, ".vercel", "project.json"), "utf8")
    .then(parseJson)
    .catch(() => undefined)
  const projectId = stringField(parsed, "projectId")
  if (!projectId) return
  const orgId = stringField(parsed, "orgId")
  return { projectId, teamId: orgId?.startsWith("team_") ? orgId : undefined }
}

function saveLink(projectPath: string, project: unknown, auth: VercelAuth, linkedFrom?: string) {
  const id = stringField(project, "id")
  const name = stringField(project, "name")
  if (!id || !name) throw new VercelError("provider", "Vercel did not return the project's id and name.")
  return saveCloudProviderProjectLink(projectPath, {
    provider: "vercel",
    projectId: id,
    projectName: name,
    accountId: stringField(project, "accountId") ?? auth.teamId,
    teamId: auth.teamId,
    url: productionUrl(project),
    linkedFrom,
    linkedAt: new Date().toISOString(),
  })
}

// `autoLink` is for Cloud Services, where the user is looking; the agent's
// status reports the candidate instead.
export async function vercelProjectStatus(
  projectPath: string,
  directory = projectPath,
  request?: VercelFetch,
  options: { autoLink?: boolean } = {},
): Promise<VercelProjectStatus> {
  const connection = cachedCloudProviderConnection("vercel")
  if (!connection.connected) return { connected: false }
  const link =
    options.autoLink === false
      ? getCloudProviderProjectLink(projectPath, undefined, "vercel")
      : await autoLinkVercelProject(projectPath, directory, request).catch(() => undefined)
  if (!link) {
    return {
      connected: true,
      account: connection.account,
      candidate: await vercelProjectCandidate(projectPath, directory),
    }
  }
  const project = await readVercelProject(await vercelLinkContext(projectPath), request).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  )
  if (project instanceof Error) return { connected: true, account: connection.account, link, error: project.message }
  return { connected: true, account: connection.account, link, project }
}

export async function readVercelProject(context: VercelLinkContext, request?: VercelFetch) {
  const project = await vercelRequest(context.auth, `/v9/projects/${encodeURIComponent(context.link.projectId)}`, {
    request,
  })
  const details = projectDetails(project, context.link.projectId)
  if (details.protection.bypassReady || typeof getStore(BYPASS_STORE).get(context.link.projectId) !== "string") {
    return details
  }
  return { ...details, protection: { ...details.protection, bypassReady: true } }
}

function projectDetails(project: unknown, projectId: string): VercelProjectDetails {
  const production = objectField(objectField(project, "targets"), "production")
  const sso = objectField(project, "ssoProtection")
  const gitLink = objectField(project, "link")
  const repo = stringField(gitLink, "repo")
  const org = stringField(gitLink, "org")
  return {
    id: stringField(project, "id") ?? projectId,
    name: stringField(project, "name") ?? projectId,
    accountId: stringField(project, "accountId"),
    settings: {
      framework: stringField(project, "framework") ?? null,
      rootDirectory: stringField(project, "rootDirectory") ?? null,
      buildCommand: stringField(project, "buildCommand") ?? null,
      outputDirectory: stringField(project, "outputDirectory") ?? null,
      installCommand: stringField(project, "installCommand") ?? null,
      nodeVersion: stringField(project, "nodeVersion") ?? null,
    },
    protection: {
      vercelAuthentication: sso ? (stringField(sso, "deploymentType") ?? "preview") : null,
      passwordProtection: Boolean(objectField(project, "passwordProtection")),
      bypassReady: bypassSecrets(project).length > 0,
    },
    productionUrl: productionUrl(project),
    productionDeploymentId: stringField(production, "id"),
    gitRepository: repo ? (org && !repo.includes("/") ? `${org}/${repo}` : repo) : undefined,
  }
}

function productionUrl(project: unknown) {
  const production = objectField(objectField(project, "targets"), "production")
  const alias = objectField(production, "alias")
  const first = Array.isArray(alias) ? alias.find((item): item is string => typeof item === "string") : undefined
  const host = first ?? (typeof alias === "string" ? alias : undefined) ?? stringField(production, "url")
  return host ? `https://${host.replace(/^https?:\/\//, "")}` : undefined
}

// https://vercel.com/docs/rest-api/projects/update-an-existing-project. An
// empty string clears a setting back to Vercel's automatic detection.
export async function updateVercelProjectSettings(
  projectPath: string,
  patch: Partial<Record<keyof VercelProjectSettings, string>>,
  request?: VercelFetch,
) {
  const body: Record<string, string | null> = {}
  if (patch.framework !== undefined) body.framework = optionalFramework(patch.framework) ?? null
  if (patch.rootDirectory !== undefined) body.rootDirectory = optionalRootDirectory(patch.rootDirectory) ?? null
  for (const key of ["buildCommand", "outputDirectory", "installCommand"] as const) {
    const value = patch[key]
    if (value === undefined) continue
    if (value.length > 256 || /[\r\n]/.test(value)) {
      throw new VercelError("invalid", `${key} must be a single line of at most 256 characters.`)
    }
    body[key] = value.trim() || null
  }
  if (patch.nodeVersion !== undefined) {
    const nodeVersion = VERCEL_NODE_VERSIONS.find((item) => item === patch.nodeVersion?.trim())
    if (!nodeVersion) {
      throw new VercelError("invalid", `Choose a Node.js version Vercel supports: ${VERCEL_NODE_VERSIONS.join(", ")}.`)
    }
    body.nodeVersion = nodeVersion
  }
  if (!Object.keys(body).length) throw new VercelError("invalid", "Name at least one project setting to change.")
  const context = await vercelLinkContext(projectPath)
  const updated = await vercelRequest(context.auth, `/v9/projects/${encodeURIComponent(context.link.projectId)}`, {
    method: "PATCH",
    body,
    request,
  })
  return projectDetails(updated, context.link.projectId)
}

function optionalFramework(value?: string) {
  const framework = value?.trim().toLowerCase()
  if (!framework) return undefined
  if (!FRAMEWORK_SLUG.test(framework)) {
    throw new VercelError("invalid", "Use Vercel's framework identifier, for example nextjs, vite, astro or sveltekit.")
  }
  return framework
}

function optionalRootDirectory(value?: string) {
  const directory = value
    ?.trim()
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "")
  if (!directory || directory === ".") return undefined
  if (directory.length > 256 || directory.startsWith("/") || directory.split("/").includes("..")) {
    throw new VercelError("invalid", "The root directory must be a relative path inside the repository.")
  }
  return directory
}

// Protection Bypass for Automation lets Vector's release checks open protected
// deployments. The secret is kept in Vector's vault, never shown or logged.
// https://vercel.com/docs/rest-api/projects/update-protection-bypass-for-automation
export async function enableVercelProtectionBypass(projectPath: string, request?: VercelFetch) {
  const context = await vercelLinkContext(projectPath)
  const before = bypassSecrets(
    await vercelRequest(context.auth, `/v9/projects/${encodeURIComponent(context.link.projectId)}`, { request }),
  )
  const response = await vercelRequest(
    context.auth,
    `/v1/projects/${encodeURIComponent(context.link.projectId)}/protection-bypass`,
    { method: "PATCH", body: { generate: { note: BYPASS_NOTE } }, request },
  )
  const created = bypassSecrets(response).find((secret) => !before.includes(secret)) ?? bypassSecrets(response)[0]
  if (!created) throw new VercelError("provider", "Vercel did not return a Protection Bypass for Automation secret.")
  getStore(BYPASS_STORE).set(context.link.projectId, encryptCloudCredential(created))
  return { enabled: true, project: context.link.projectName }
}

// The secret Vector generated, or one the user created in Vercel's settings.
export async function vercelBypassSecret(context: VercelLinkContext, request?: VercelFetch) {
  const stored = getStore(BYPASS_STORE).get(context.link.projectId)
  // A secret the vault can no longer decrypt is dropped, and Vercel's own is read instead.
  const decrypted =
    typeof stored === "string"
      ? await Promise.resolve(stored)
          .then(decryptCloudCredential)
          .catch(() => {
            getStore(BYPASS_STORE).delete(context.link.projectId)
            return undefined
          })
      : undefined
  if (decrypted) return decrypted
  const project = await vercelRequest(context.auth, `/v9/projects/${encodeURIComponent(context.link.projectId)}`, {
    request,
  }).catch(() => undefined)
  return bypassSecrets(project)[0]
}

// protectionBypass maps each secret to { scope: "automation-bypass", ... }.
function bypassSecrets(value: unknown) {
  const map = objectField(value, "protectionBypass")
  if (!map || typeof map !== "object") return []
  return Object.entries(map).flatMap(([secret, info]) =>
    stringField(info, "scope") === "automation-bypass" ? [secret] : [],
  )
}

// The slug Vercel puts in generated URLs: the team's slug, or the username.
export async function vercelScopeSlug(context: VercelLinkContext, request?: VercelFetch) {
  const teamId = linkTeamId(context.link)
  if (teamId) {
    const team = await vercelRequest(context.auth, `/v2/teams/${encodeURIComponent(teamId)}`, {
      request,
      unscoped: true,
    })
    return stringField(team, "slug")
  }
  const body = await vercelRequest(context.auth, "/v2/user", { request, unscoped: true })
  return stringField(objectField(body, "user") ?? body, "username")
}
