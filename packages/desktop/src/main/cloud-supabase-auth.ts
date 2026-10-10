import { listDeployments, listDomains } from "./cloud-console"
import { getCloudProviderProjectLink, getCloudProviderRuntimeAuth } from "./cloud-connections"
import {
  booleanField,
  management,
  projectService,
  refPath,
  responseArray,
  stringField,
  type CloudFetch,
  type SupabaseContext,
} from "./cloud-supabase-api"

// Supabase Auth for the linked project: where sign-in may redirect, which
// sign-in methods are on, and the users themselves. Provider client secrets go
// to Supabase and are never read back; a summary only says whether one is set.

export const AUTH_PROVIDERS = ["google", "github", "apple"] as const
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]

export type AuthProviderSettings = { enabled: boolean; clientId?: string; secretSet: boolean }

export type AuthSummary = {
  siteUrl?: string
  redirectUrls: string[]
  email: { enabled: boolean; signupDisabled: boolean }
  providers: Record<AuthProvider, AuthProviderSettings>
}

export type AuthUpdate = {
  siteUrl?: string
  /** Replaces the whole allow list. */
  redirectUrls?: string[]
  addRedirectUrls?: string[]
  removeRedirectUrls?: string[]
  emailEnabled?: boolean
  providers?: Partial<Record<AuthProvider, { enabled?: boolean; clientId?: string; secret?: string }>>
}

// Apple's secret is only needed for the web OAuth flow; native Sign in with
// Apple works with the client id alone.
const SECRET_REQUIRED: Record<AuthProvider, boolean> = { google: true, github: true, apple: false }
const LABEL: Record<AuthProvider, string> = { google: "Google", github: "GitHub", apple: "Apple" }

function summarize(config: unknown): AuthSummary {
  const provider = (name: AuthProvider): AuthProviderSettings => ({
    enabled: booleanField(config, `external_${name}_enabled`) === true,
    clientId: stringField(config, `external_${name}_client_id`),
    secretSet: Boolean(stringField(config, `external_${name}_secret`)),
  })
  return {
    siteUrl: stringField(config, "site_url"),
    redirectUrls: splitAllowList(stringField(config, "uri_allow_list")),
    email: {
      enabled: booleanField(config, "external_email_enabled") !== false,
      signupDisabled: booleanField(config, "disable_signup") === true,
    },
    providers: { google: provider("google"), github: provider("github"), apple: provider("apple") },
  }
}

function splitAllowList(value?: string) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

// https://supabase.com/docs/reference/api/v1-get-auth-service-config
export async function getAuthConfig(context: SupabaseContext) {
  return summarize(await management(context, refPath(context, "/config/auth")))
}

// https://supabase.com/docs/reference/api/v1-update-auth-service-config
export async function updateAuthConfig(context: SupabaseContext, input: AuthUpdate) {
  const current = summarize(await management(context, refPath(context, "/config/auth")))
  const body: Record<string, unknown> = {}
  if (input.siteUrl !== undefined) body.site_url = requireUrl(input.siteUrl, "site URL")
  if (input.redirectUrls || input.addRedirectUrls || input.removeRedirectUrls) {
    const removed = new Set((input.removeRedirectUrls ?? []).map((item) => item.trim()))
    const next = [...(input.redirectUrls ?? current.redirectUrls), ...(input.addRedirectUrls ?? [])]
      .map((item) => requireRedirect(item))
      .filter((item) => !removed.has(item))
    body.uri_allow_list = Array.from(new Set(next)).join(",")
  }
  if (input.emailEnabled !== undefined) body.external_email_enabled = input.emailEnabled
  for (const name of AUTH_PROVIDERS) {
    const change = input.providers?.[name]
    if (!change) continue
    const clientId = change.clientId?.trim()
    const secret = change.secret?.trim()
    if (clientId !== undefined) body[`external_${name}_client_id`] = clientId
    if (secret) body[`external_${name}_secret`] = secret
    if (change.enabled === true) {
      if (!(clientId || current.providers[name].clientId)) {
        throw new Error(`Enter the ${LABEL[name]} client ID before turning ${LABEL[name]} sign-in on.`)
      }
      if (SECRET_REQUIRED[name] && !(secret || current.providers[name].secretSet)) {
        throw new Error(
          `Enter the ${LABEL[name]} client secret in Cloud Services > Authentication before turning ${LABEL[name]} sign-in on. Vector never takes it from chat.`,
        )
      }
    }
    if (change.enabled !== undefined) body[`external_${name}_enabled`] = change.enabled
  }
  if (!Object.keys(body).length) return { auth: current, changed: [] as string[] }
  const updated = summarize(
    await management(context, refPath(context, "/config/auth"), { method: "PATCH", json: body }),
  )
  return {
    auth: updated,
    // Field names only: a secret's value never appears in a result.
    changed: Object.keys(body).map((key) => (key.endsWith("_secret") ? `${key} (set)` : key)),
  }
}

function requireUrl(value: string, label: string) {
  const url = value.trim()
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    throw new Error(`The ${label} must be a full http(s) address, such as https://app.example.com.`)
  }
  return url
}

// Redirect entries may use Supabase's globs (* and **) and app schemes for
// mobile deep links, but never the comma that separates the list.
// https://supabase.com/docs/guides/auth/redirect-urls
function requireRedirect(value: string) {
  const entry = value.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s,]+$/i.test(entry)) {
    throw new Error(`"${value}" is not a redirect URL. Use a full address such as https://app.example.com/**.`)
  }
  return entry
}

// The addresses a Vercel-hosted app signs in from: its production domains,
// and every preview under its team, which Supabase recommends allowing as
// https://*-<team-slug>.vercel.app/** (https://supabase.com/docs/guides/auth/redirect-urls#vercel-preview-urls).
// A preview URL is <project>-<9-character hash>-<scope>.vercel.app
// (https://vercel.com/docs/deployments/generated-urls), which is where the
// team slug comes from.
export async function vercelRedirectSuggestions(projectPath: string, request: CloudFetch = fetch) {
  const link = getCloudProviderProjectLink(projectPath, undefined, "vercel")
  if (!link) return { redirectUrls: [], detail: "Link a Vercel project in Cloud Services > Integrations first." }
  const production = [
    ...listDomains(projectPath)
      .filter((domain) => domain.status === "verified")
      .map((domain) => `https://${domain.domain}`),
    ...(link.url ? [link.url.replace(/\/$/, "")] : []),
  ]
  const scope =
    previewScope(
      link.projectName,
      listDeployments(projectPath)
        .filter((item) => item.environment === "preview")
        .map((item) => item.url),
    ) ?? (await remotePreviewScope(link.projectId, link.projectName, request))
  const redirectUrls = [...production.map((url) => `${url}/**`), ...(scope ? [`https://*-${scope}.vercel.app/**`] : [])]
  return {
    siteUrl: production[0],
    redirectUrls: Array.from(new Set(redirectUrls)),
    detail: scope
      ? undefined
      : "No preview deployment was found yet, so preview addresses are not included. Publish a preview, then add them.",
  }
}

export function previewScope(projectName: string, urls: string[]) {
  const prefix = `${projectName.toLowerCase()}-`
  for (const url of urls) {
    if (!URL.canParse(url)) continue
    const host = new URL(url).hostname.toLowerCase()
    if (!host.endsWith(".vercel.app") || !host.startsWith(prefix)) continue
    const scope = host.slice(prefix.length, -".vercel.app".length).match(/^[a-z0-9]{9}-([a-z0-9-]+)$/)?.[1]
    if (scope && !scope.startsWith("git-")) return scope
  }
}

// https://vercel.com/docs/rest-api/reference/endpoints/deployments/list-deployments
async function remotePreviewScope(projectId: string, projectName: string, request: CloudFetch) {
  const auth = await getCloudProviderRuntimeAuth("vercel")
  if (!auth.token) return
  const url = new URL("https://api.vercel.com/v6/deployments")
  url.searchParams.set("projectId", projectId)
  url.searchParams.set("limit", "20")
  if (auth.teamId) url.searchParams.set("teamId", auth.teamId)
  const response = await request(url, {
    headers: { authorization: `Bearer ${auth.token}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined)
  const body: unknown = await response?.json().catch(() => undefined)
  if (!response?.ok) return
  return previewScope(
    projectName,
    responseArray(body, "deployments")
      .map((item) => stringField(item, "url"))
      .filter((item): item is string => Boolean(item))
      .map((host) => `https://${host}`),
  )
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

// The auth admin API needs the service-role key, which stays in this process.
// https://supabase.com/docs/reference/javascript/auth-admin-listusers
export async function listAuthUsers(context: SupabaseContext, input: { page?: number; perPage?: number }) {
  const page = Math.max(1, Math.trunc(input.page ?? 1))
  const perPage = Math.min(100, Math.max(1, Math.trunc(input.perPage ?? 50)))
  const body = await projectService(context, `/auth/v1/admin/users?page=${page}&per_page=${perPage}`)
  const users = responseArray(body, "users")
    .map((user): AuthUser | undefined => {
      const id = stringField(user, "id")
      if (!id) return
      const metadata = user && typeof user === "object" ? Reflect.get(user, "app_metadata") : undefined
      const providers = metadata && typeof metadata === "object" ? Reflect.get(metadata, "providers") : undefined
      return {
        id,
        email: stringField(user, "email"),
        phone: stringField(user, "phone"),
        createdAt: stringField(user, "created_at"),
        lastSignInAt: stringField(user, "last_sign_in_at"),
        confirmed: Boolean(stringField(user, "email_confirmed_at") ?? stringField(user, "confirmed_at")),
        providers: Array.isArray(providers) ? providers.filter((item): item is string => typeof item === "string") : [],
      }
    })
    .filter((user): user is AuthUser => Boolean(user))
  return { users, page, perPage, hasMore: users.length === perPage }
}

// https://supabase.com/docs/reference/javascript/auth-admin-inviteuserbyemail
export async function inviteAuthUser(context: SupabaseContext, input: { email: string; redirectTo?: string }) {
  const email = input.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`"${input.email}" is not an email address.`)
  const query = input.redirectTo ? `?redirect_to=${encodeURIComponent(requireRedirect(input.redirectTo))}` : ""
  const user = await projectService(context, `/auth/v1/invite${query}`, { method: "POST", json: { email } })
  return { invited: { id: stringField(user, "id"), email }, detail: `Supabase sent an invitation to ${email}.` }
}

// https://supabase.com/docs/reference/javascript/auth-admin-deleteuser
export async function deleteAuthUser(context: SupabaseContext, input: { userId: string }) {
  const id = input.userId.trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Choose a user by their Supabase user id.")
  }
  await projectService(context, `/auth/v1/admin/users/${id}`, { method: "DELETE" })
  return { deleted: id, detail: `User ${id} was deleted from ${context.projectName}.` }
}
