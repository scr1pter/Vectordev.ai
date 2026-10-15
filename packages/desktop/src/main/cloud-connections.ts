import { VECTOR_USER_AGENT } from "./user-agent"
import { createHash, randomBytes, type KeyObject } from "node:crypto"
import { shell } from "electron"
import {
  cloudOAuthAuthorizeUrl,
  createCloudOAuthRelay,
  matchesCloudOAuthState,
  readCloudOAuthCallback,
} from "./cloud-oauth-relay"

import { cloudProjectScopeKey } from "./cloud-console"
import { decryptCloudCredential, encryptCloudCredential } from "./cloud-credential-vault"
import { getStore, removeStoreFileIfEmpty } from "./store"
import { validateCloudProviderToken, type CloudProviderId } from "./cloud-provider-token"
import { vercelApiBase } from "./cloud-vercel-api"

export { decryptCloudCredential, encryptCloudCredential } from "./cloud-credential-vault"
export type { CloudProviderId } from "./cloud-provider-token"

type CloudFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type CloudProviderConnection = {
  provider: CloudProviderId
  configured: boolean
  manualTokenSupported: true
  connected: boolean
  account?: string
  accountId?: string
  connectedAt?: string
  detail: string
  callbackUrl?: string
}

export type CloudProviderResource = {
  provider: CloudProviderId
  id: string
  name: string
  accountId?: string
  accountName?: string
  url?: string
  region?: string
  status?: string
}

export type CloudProviderProjectLink = {
  provider: Exclude<CloudProviderId, "supabase">
  projectId: string
  projectName: string
  accountId?: string
  accountName?: string
  /** The Vercel team the project belongs to; absent for a personal account. */
  teamId?: string
  url?: string
  /** Set when Vector linked the project from the repository's .vercel/project.json. */
  linkedFrom?: string
  linkedAt: string
}

type StoredConnection = {
  provider: CloudProviderId
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  account?: string
  accountId?: string
  teamId?: string
  configurationId?: string
  connectedAt: string
}

type BrokerProviderStatus = {
  provider: CloudProviderId
  configured: boolean
  callbackUrl?: string
  missing?: string[]
}

type ActiveOAuthFlow = {
  provider: CloudProviderId
  state: string
  codeVerifier?: string
  privateKey?: KeyObject
  timeout: ReturnType<typeof setTimeout>
  resolve: (connection: CloudProviderConnection) => void
  reject: (error: Error) => void
}

const CONNECTION_STORE = "cloud-provider-connections"
const LINKS_STORE = "cloud-provider-links"
const STORE_KEY = "records"
const DEFAULT_BROKER_URL = "https://vectordev.ai/api/cloud/oauth"
const PROVIDERS: CloudProviderId[] = ["vercel", "supabase"]
const activeFlows = new Map<CloudProviderId, ActiveOAuthFlow>()

function brokerUrl(): string {
  return (process.env.VECTOR_OAUTH_BROKER_URL?.trim() || DEFAULT_BROKER_URL).replace(/\/$/, "")
}

function now(): string {
  return new Date().toISOString()
}

function isProvider(value: unknown): value is CloudProviderId {
  return value === "vercel" || value === "supabase"
}

function readConnections(): StoredConnection[] {
  const raw = getStore(CONNECTION_STORE).get(STORE_KEY)
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is StoredConnection => {
    if (!value || typeof value !== "object") return false
    return (
      isProvider(Reflect.get(value, "provider")) &&
      typeof Reflect.get(value, "accessToken") === "string" &&
      typeof Reflect.get(value, "connectedAt") === "string"
    )
  })
}

function writeConnections(records: StoredConnection[]): void {
  getStore(CONNECTION_STORE).set(STORE_KEY, records)
}

function storedConnection(provider: CloudProviderId): StoredConnection | undefined {
  return readConnections().find((item) => item.provider === provider)
}

function saveConnection(record: StoredConnection): void {
  writeConnections([record, ...readConnections().filter((item) => item.provider !== record.provider)])
}

// Netlify is no longer a supported provider, so nothing can use or revoke a
// Netlify credential that an older release saved. readConnections already
// ignores it; this deletes it from the vault so it does not linger on disk.
export function forgetRetiredCloudProviders(): number {
  const store = getStore(CONNECTION_STORE)
  const raw = store.get(STORE_KEY)
  if (!Array.isArray(raw)) return 0
  const kept = raw.filter(
    (value) => !value || typeof value !== "object" || Reflect.get(value, "provider") !== "netlify",
  )
  if (kept.length === raw.length) return 0
  store.set(STORE_KEY, kept)
  return raw.length - kept.length
}

function connectionLabel(provider: CloudProviderId): string {
  return provider === "vercel" ? "Vercel" : "Supabase"
}

async function brokerRequest<T>(path: string, init?: RequestInit, request: CloudFetch = fetch): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set("accept", "application/json")
  if (init?.body) headers.set("content-type", "application/json")
  const response = await request(`${brokerUrl()}${path}`, {
    ...init,
    headers,
    redirect: "error",
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  }).catch((error) => {
    throw new Error(
      error instanceof Error
        ? `Could not reach Vector's connection service: ${error.message}`
        : "Could not reach Vector's connection service.",
    )
  })
  const body = (await response.json().catch(() => undefined)) as (T & { ok?: boolean; error?: string }) | undefined
  if (!response.ok || !body || body.ok === false) {
    throw new Error(body?.error || `Vector's connection service returned HTTP ${response.status}.`)
  }
  return body
}

async function brokerStatuses(): Promise<BrokerProviderStatus[]> {
  const response = await brokerRequest<{ providers: BrokerProviderStatus[] }>("/status?relay=v1")
  return Array.isArray(response.providers) ? response.providers : []
}

export async function listCloudProviderConnections(): Promise<CloudProviderConnection[]> {
  const configured = await brokerStatuses().catch(() => [])
  const records = readConnections()
  return PROVIDERS.map((provider) => {
    const remote = configured.find((item) => item.provider === provider)
    const local = records.find((item) => item.provider === provider)
    const appConfigured = remote?.configured === true
    const connected = Boolean(local)
    let detail = connected ? `Connected${local?.account ? ` as ${local.account}` : ""}.` : "Not connected."
    if (!appConfigured && !connected) {
      detail = remote
        ? "Browser sign-in is not available yet. Connect with a personal access token instead."
        : "Vector's connection service is unavailable. You can still connect with a personal access token."
    }
    return {
      provider,
      manualTokenSupported: true,
      configured: appConfigured,
      connected,
      account: local?.account,
      accountId: local?.accountId,
      connectedAt: local?.connectedAt,
      callbackUrl: remote?.callbackUrl,
      detail,
    }
  })
}

export function cachedCloudProviderConnection(provider: CloudProviderId): CloudProviderConnection {
  const local = storedConnection(provider)
  return {
    provider,
    configured: true,
    manualTokenSupported: true,
    connected: Boolean(local),
    account: local?.account,
    accountId: local?.accountId,
    connectedAt: local?.connectedAt,
    detail: local ? `Connected${local.account ? ` as ${local.account}` : ""}.` : "Not connected.",
  }
}

function makePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

function cancelFlow(provider: CloudProviderId, error?: Error): void {
  const flow = activeFlows.get(provider)
  if (!flow) return
  clearTimeout(flow.timeout)
  activeFlows.delete(provider)
  if (error) flow.reject(error)
}

export async function connectCloudProvider(provider: CloudProviderId): Promise<CloudProviderConnection> {
  cancelFlow(provider, new Error(`${connectionLabel(provider)} connection was restarted.`))

  const pkce = provider === "supabase" ? makePkce() : undefined
  const relay = provider === "supabase" ? undefined : createCloudOAuthRelay()
  const state = relay?.state ?? randomBytes(32).toString("base64url")
  const start = await brokerRequest<{ authorizeUrl: string; callbackUrl: string; state: string }>("/start", {
    method: "POST",
    body: JSON.stringify({ provider, state, codeChallenge: pkce?.challenge }),
  })
  const authorizeUrl = cloudOAuthAuthorizeUrl(provider, start.authorizeUrl)

  const pending = new Promise<CloudProviderConnection>((resolve, reject) => {
    const timeout = setTimeout(() => {
      activeFlows.delete(provider)
      reject(new Error(`${connectionLabel(provider)} connection timed out. Start again.`))
    }, 10 * 60_000)
    timeout.unref()
    activeFlows.set(provider, {
      provider,
      state: start.state,
      codeVerifier: pkce?.verifier,
      privateKey: relay?.privateKey,
      timeout,
      resolve,
      reject,
    })
  })

  await shell.openExternal(authorizeUrl).catch((error) => {
    cancelFlow(provider)
    throw new Error(error instanceof Error ? error.message : "Could not open the provider sign-in page.")
  })
  return pending
}

export async function connectCloudProviderWithToken(
  provider: CloudProviderId,
  value: string,
): Promise<CloudProviderConnection> {
  cancelFlow(provider, new Error(`${connectionLabel(provider)} connection was restarted.`))
  const accessToken = value.trim()
  const identity = await validateCloudProviderToken(provider, accessToken)
  const connectedAt = now()
  saveConnection({
    provider,
    accessToken: encryptCloudCredential(accessToken),
    account: identity.account,
    accountId: identity.accountId,
    connectedAt,
  })
  return {
    provider,
    configured: false,
    manualTokenSupported: true,
    connected: true,
    account: identity.account,
    accountId: identity.accountId,
    connectedAt,
    detail: `Connected${identity.account ? ` as ${identity.account}` : ""}.`,
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = Reflect.get(value, key)
  return typeof field === "string" && field ? field : undefined
}

async function providerJson(
  token: string,
  url: string,
  init?: RequestInit,
  request: CloudFetch = fetch,
): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set("accept", "application/json")
  headers.set("authorization", `Bearer ${token}`)
  headers.set("user-agent", VECTOR_USER_AGENT)
  const response = await request(url, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message =
      stringField(body, "message") ??
      stringField(body, "error_description") ??
      stringField(body, "error") ??
      `Provider returned HTTP ${response.status}.`
    throw new Error(message)
  }
  return body
}

async function finishOAuthDeepLink(url: URL): Promise<void> {
  const providerValue = url.searchParams.get("provider")
  if (!isProvider(providerValue)) return
  const flow = activeFlows.get(providerValue)
  if (!flow) throw new Error(`No ${connectionLabel(providerValue)} connection is waiting for approval.`)
  const authorization = readCloudOAuthCallback(providerValue, url, flow)
  const returnedState = flow.state

  const token = await brokerRequest<{
    accessToken: string
    refreshToken?: string
    expiresIn?: number
    teamId?: string
  }>("/exchange", {
    method: "POST",
    body: JSON.stringify({
      provider: providerValue,
      code: authorization,
      state: returnedState,
      codeVerifier: flow.codeVerifier,
    }),
  })
  const teamId = token.teamId ?? url.searchParams.get("teamId") ?? undefined
  if (!token.accessToken) throw new Error(`${connectionLabel(providerValue)} did not return an access token.`)

  const identity = await validateCloudProviderToken(providerValue, token.accessToken, fetch, teamId)
  const connectedAt = now()
  saveConnection({
    provider: providerValue,
    accessToken: encryptCloudCredential(token.accessToken),
    refreshToken: token.refreshToken ? encryptCloudCredential(token.refreshToken) : undefined,
    expiresAt: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : undefined,
    account: identity.account,
    accountId: identity.accountId,
    teamId,
    configurationId: url.searchParams.get("configurationId") ?? undefined,
    connectedAt,
  })
  clearTimeout(flow.timeout)
  activeFlows.delete(providerValue)
  flow.resolve({
    provider: providerValue,
    configured: true,
    manualTokenSupported: true,
    connected: true,
    account: identity.account,
    accountId: identity.accountId,
    connectedAt,
    detail: `Connected${identity.account ? ` as ${identity.account}` : ""}.`,
  })
}

export async function handleCloudOAuthDeepLinks(urls: string[]): Promise<string[]> {
  const remaining: string[] = []
  for (const value of urls) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      remaining.push(value)
      continue
    }
    if (url.protocol !== "vector:" || url.hostname !== "cloud" || url.pathname !== "/oauth") {
      remaining.push(value)
      continue
    }
    const provider = url.searchParams.get("provider")
    const flow = isProvider(provider) ? activeFlows.get(provider) : undefined
    // An unrelated protocol invocation must not cancel a pending approval.
    if (!flow || !matchesCloudOAuthState(flow.state, url.searchParams.get("state") ?? "")) continue
    try {
      await finishOAuthDeepLink(url)
    } catch (error) {
      if (isProvider(provider)) {
        const flow = activeFlows.get(provider)
        if (flow) {
          clearTimeout(flow.timeout)
          activeFlows.delete(provider)
          flow.reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
    }
  }
  return remaining
}

// Removes Vector's credential and, for a sign-in connection, revokes it on the
// provider too: Supabase's OAuth grant through the broker, and Vercel's
// integration installation, which is what its token belongs to. A personal
// access token the user pasted is theirs, so only Vector's copy is deleted.
// The local credential goes even when revoking fails, and `detail` says which.
export async function disconnectCloudProvider(
  provider: CloudProviderId,
  request: CloudFetch = fetch,
): Promise<{ revoked: boolean; detail: string }> {
  cancelFlow(provider, new Error(`${connectionLabel(provider)} connection was cancelled.`))
  const connection = storedConnection(provider)
  const label = connectionLabel(provider)
  const revoked = connection ? await revokeConnection(connection, request) : undefined
  const records = readConnections().filter((item) => item.provider !== provider)
  writeConnections(records)
  await removeStoreFileIfEmpty(CONNECTION_STORE)
  if (revoked === true) return { revoked: true, detail: `${label} disconnected, and Vector's access on ${label} is revoked.` }
  if (revoked === false) {
    return {
      revoked: false,
      detail:
        provider === "vercel"
          ? "Vercel disconnected from Vector, but Vercel did not confirm removing Vector's integration. It still has access until you remove Vector under your Vercel team's Integrations."
          : "Supabase disconnected from Vector, but Supabase did not confirm revoking Vector's access. It still has access until you remove Vector under your Supabase organization's OAuth Apps.",
    }
  }
  return {
    revoked: false,
    detail: connection
      ? `${label} disconnected. Vector deleted its copy of your access token; the token itself stays valid until you delete it in ${label}'s token settings.`
      : `${label} is not connected.`,
  }
}

// true when the provider confirmed the revocation, false when it was tried and
// failed, undefined when there is nothing for Vector to revoke.
async function revokeConnection(connection: StoredConnection, request: CloudFetch) {
  if (connection.provider === "supabase") {
    if (!connection.refreshToken) return undefined
    const refreshToken = decryptCloudCredential(connection.refreshToken)
    return brokerRequest("/revoke", {
      method: "POST",
      body: JSON.stringify({ provider: "supabase", refreshToken }),
    }).then(
      () => true,
      () => false,
    )
  }
  if (!connection.configurationId) return undefined
  // https://vercel.com/docs/rest-api/reference/endpoints/integrations/delete-an-integration-configuration
  const url = new URL(
    `${vercelApiBase()}/v1/integrations/configuration/${encodeURIComponent(connection.configurationId)}`,
  )
  if (connection.teamId) url.searchParams.set("teamId", connection.teamId)
  return request(url, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${decryptCloudCredential(connection.accessToken)}`,
      "user-agent": VECTOR_USER_AGENT,
    },
    signal: AbortSignal.timeout(20_000),
  }).then(
    async (response) =>
      // Already removed on Vercel, or the token no longer works: Vector has no access left either way.
      response.ok ||
      response.status === 404 ||
      ((response.status === 401 || response.status === 403) &&
        (await response
          .json()
          .then((body: unknown) => Reflect.get(Reflect.get(Object(body), "error") ?? {}, "invalidToken") === true)
          .catch(() => false))),
    () => false,
  )
}

async function accessToken(
  provider: CloudProviderId,
  request: CloudFetch = fetch,
): Promise<{ token: string; record: StoredConnection }> {
  let record = storedConnection(provider)
  if (!record) throw new Error(`Connect ${connectionLabel(provider)} in Vector Cloud first.`)
  if (
    provider === "supabase" &&
    record.refreshToken &&
    record.expiresAt &&
    Date.parse(record.expiresAt) <= Date.now() + 60_000
  ) {
    const refreshToken = decryptCloudCredential(record.refreshToken)
    const refreshed = await brokerRequest<{
      accessToken: string
      refreshToken?: string
      expiresIn?: number
    }>(
      "/refresh",
      {
        method: "POST",
        body: JSON.stringify({ provider: "supabase", refreshToken }),
      },
      request,
    ).catch(() => {
      // Broker diagnostics can echo a rejected credential. Keep it out of
      // agent reports and retain the old record when renewal fails.
      throw new Error("Supabase could not renew its connection. Reconnect Supabase in Vector Cloud.")
    })
    if (typeof refreshed.accessToken !== "string" || !refreshed.accessToken.trim()) {
      throw new Error("Supabase did not return a renewed access token. Reconnect Supabase in Vector Cloud.")
    }
    record = {
      ...record,
      accessToken: encryptCloudCredential(refreshed.accessToken),
      refreshToken: encryptCloudCredential(refreshed.refreshToken ?? refreshToken),
      expiresAt: refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString() : undefined,
    }
    saveConnection(record)
  }
  const token = decryptCloudCredential(record.accessToken)
  return { token, record }
}

export async function getSupabaseManagementToken(request: CloudFetch = fetch): Promise<string | undefined> {
  if (!storedConnection("supabase")) return undefined
  return (await accessToken("supabase", request)).token
}

export async function getCloudProviderRuntimeAuth(
  provider: Exclude<CloudProviderId, "supabase">,
): Promise<{ token?: string; account?: string; accountId?: string; teamId?: string }> {
  const record = storedConnection(provider)
  if (!record) return {}
  return {
    token: decryptCloudCredential(record.accessToken),
    account: record.account,
    accountId: record.accountId,
    teamId: record.teamId,
  }
}

// The team a Vercel token lists projects in until a project link names its own.
// Undefined selects the personal account.
export function setCloudProviderDefaultTeam(provider: Exclude<CloudProviderId, "supabase">, teamId?: string): void {
  const record = storedConnection(provider)
  if (!record) throw new Error(`Connect ${connectionLabel(provider)} in Vector Cloud first.`)
  saveConnection({ ...record, teamId })
}

export async function listCloudProviderResources(provider: CloudProviderId): Promise<CloudProviderResource[]> {
  if (provider === "vercel") {
    // Every page, in the connection's default team scope.
    const { listVercelProjects } = await import("./cloud-vercel-projects")
    return (await listVercelProjects()).map((project) => ({
      provider,
      id: project.id,
      name: project.name,
      accountId: project.accountId,
      url: project.productionUrl,
    }))
  }
  const auth = await accessToken(provider)
  const body = await providerJson(auth.token, "https://api.supabase.com/v1/projects")
  if (!Array.isArray(body)) return []
  return body
    .map((project): CloudProviderResource | undefined => {
      const id = stringField(project, "id") ?? stringField(project, "ref")
      const name = stringField(project, "name")
      if (!id || !name) return
      const organizationId = stringField(project, "organization_id")
      return {
        provider,
        id,
        name,
        accountId: organizationId,
        accountName: auth.record.account,
        url: `https://${id}.supabase.co`,
        region: stringField(project, "region"),
        status: stringField(project, "status"),
      }
    })
    .filter((project): project is CloudProviderResource => Boolean(project))
}

// Same scope as the rest of a project's cloud state: the link the user picked in
// the Cloud Console has to be the link an agent-driven publish finds, or publish
// dead-ends on "Choose a Vercel project in Vector Cloud" with no way to comply.
// See cloudProjectScopeKey for why taskId is accepted here but never hashed.
function readLinks(projectPath: string): CloudProviderProjectLink[] {
  const raw = getStore(LINKS_STORE).get(cloudProjectScopeKey(projectPath))
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is CloudProviderProjectLink => {
    if (!value || typeof value !== "object") return false
    // Links to retired hosts (Netlify) stay in the store untouched but are
    // never surfaced: only Vercel is a supported hosting provider.
    return (
      Reflect.get(value, "provider") === "vercel" &&
      typeof Reflect.get(value, "projectId") === "string" &&
      typeof Reflect.get(value, "projectName") === "string" &&
      typeof Reflect.get(value, "linkedAt") === "string"
    )
  })
}

export function listCloudProviderProjectLinks(projectPath: string, taskId?: string): CloudProviderProjectLink[] {
  if (!projectPath.trim()) return []
  return readLinks(projectPath)
}

export function getCloudProviderProjectLink(
  projectPath: string,
  taskId: string | undefined,
  provider: Exclude<CloudProviderId, "supabase">,
): CloudProviderProjectLink | undefined {
  if (!projectPath.trim()) return
  return readLinks(projectPath).find((item) => item.provider === provider)
}

// Vercel links are made by cloud-vercel-projects, which reads the project and
// its team from Vercel before saving it here.
export function saveCloudProviderProjectLink(
  projectPath: string,
  link: CloudProviderProjectLink,
): CloudProviderProjectLink {
  if (!projectPath.trim()) throw new Error("Open a project before linking a cloud project.")
  const next = [link, ...readLinks(projectPath).filter((item) => item.provider !== link.provider)]
  getStore(LINKS_STORE).set(cloudProjectScopeKey(projectPath), next)
  return link
}

export async function unlinkCloudProviderProject(
  projectPath: string,
  taskId: string | undefined,
  provider: Exclude<CloudProviderId, "supabase">,
): Promise<CloudProviderProjectLink[]> {
  const next = readLinks(projectPath).filter((item) => item.provider !== provider)
  const store = getStore(LINKS_STORE)
  if (next.length) store.set(cloudProjectScopeKey(projectPath), next)
  else store.delete(cloudProjectScopeKey(projectPath))
  await removeStoreFileIfEmpty(LINKS_STORE)
  return next
}
