import { constants, createHash, generateKeyPairSync, privateDecrypt, randomBytes, type KeyObject } from "node:crypto"
import { shell } from "electron"

import {
  addDomain,
  cloudProjectScopeKey,
  connectDatabase,
  getDatabase,
  listDomains,
  listEnv,
  normalizeCloudDomain,
  removeDomain,
  updateDomainRecord,
  verifyDomain,
  type CloudDatabaseConnection,
  type CloudDomain,
} from "./cloud-console"
import { decryptCloudCredential, encryptCloudCredential } from "./cloud-credential-vault"
import {
  addNetlifyDomainAlias,
  netlifyEnvironmentPayload,
  removeNetlifyDomainAlias,
  vercelEnvironmentPayload,
} from "./cloud-provider-payloads"
import { getStore, removeStoreFileIfEmpty } from "./store"

export { decryptCloudCredential, encryptCloudCredential } from "./cloud-credential-vault"

export type CloudProviderId = "vercel" | "netlify" | "supabase"

export type CloudProviderConnection = {
  provider: CloudProviderId
  configured: boolean
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
  url?: string
  linkedAt: string
}

export type CloudProviderSyncResult = {
  provider: Exclude<CloudProviderId, "supabase">
  projectId: string
  projectName: string
  changed: number
  syncedAt: string
  detail: string
}

export type CloudSupabaseBucket = {
  id: string
  name: string
  public: boolean
  createdAt?: string
  updatedAt?: string
}

export type CloudSupabaseFunction = {
  id: string
  name: string
  slug: string
  status?: string
  version?: number
  createdAt?: string
  updatedAt?: string
}

export type CloudSupabaseServices = {
  connected: boolean
  projectRef?: string
  projectName?: string
  region?: string
  dashboardUrl?: string
  detail?: string
  storage: {
    available: boolean
    buckets: CloudSupabaseBucket[]
    detail?: string
  }
  functions: {
    available: boolean
    functions: CloudSupabaseFunction[]
    detail?: string
  }
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
const PROVIDERS: CloudProviderId[] = ["vercel", "netlify", "supabase"]
const activeFlows = new Map<CloudProviderId, ActiveOAuthFlow>()

function brokerUrl(): string {
  return (process.env.VECTOR_OAUTH_BROKER_URL?.trim() || DEFAULT_BROKER_URL).replace(/\/$/, "")
}

function now(): string {
  return new Date().toISOString()
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url")
}

function isProvider(value: unknown): value is CloudProviderId {
  return value === "vercel" || value === "netlify" || value === "supabase"
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

function connectionLabel(provider: CloudProviderId): string {
  if (provider === "vercel") return "Vercel"
  if (provider === "netlify") return "Netlify"
  return "Supabase"
}

async function brokerRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set("accept", "application/json")
  if (init?.body) headers.set("content-type", "application/json")
  const response = await fetch(`${brokerUrl()}${path}`, {
    ...init,
    headers,
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
  const response = await brokerRequest<{ providers: BrokerProviderStatus[] }>("/status")
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
    if (!appConfigured) {
      detail = remote
        ? `OAuth setup is incomplete: ${(remote.missing ?? []).join(", ")}.`
        : "Vector's connection service is unavailable."
    }
    return {
      provider,
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

function makeNetlifyRelay(): {
  state: string
  privateKey: KeyObject
} {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const nonce = randomBytes(32).toString("base64url")
  return {
    state: `${nonce}.${base64Url(JSON.stringify(keys.publicKey.export({ format: "jwk" })))}`,
    privateKey: keys.privateKey,
  }
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
  const relay = provider === "netlify" ? makeNetlifyRelay() : undefined
  const state = relay?.state ?? randomBytes(32).toString("base64url")
  const start = await brokerRequest<{ authorizeUrl: string; callbackUrl: string; state: string }>("/start", {
    method: "POST",
    body: JSON.stringify({ provider, state, codeChallenge: pkce?.challenge }),
  })
  if (!URL.canParse(start.authorizeUrl)) throw new Error("The provider returned an invalid authorization URL.")

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

  await shell.openExternal(start.authorizeUrl).catch((error) => {
    cancelFlow(provider)
    throw new Error(error instanceof Error ? error.message : "Could not open the provider sign-in page.")
  })
  return pending
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest()
  const rightHash = createHash("sha256").update(right).digest()
  return leftHash.equals(rightHash)
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = Reflect.get(value, key)
  return typeof field === "string" && field ? field : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = Reflect.get(value, key)
  return typeof field === "number" && Number.isFinite(field) ? field : undefined
}

function booleanField(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = Reflect.get(value, key)
  return typeof field === "boolean" ? field : undefined
}

async function providerJson(token: string, url: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set("accept", "application/json")
  headers.set("authorization", `Bearer ${token}`)
  headers.set("user-agent", "Vector-Desktop/1")
  const response = await fetch(url, {
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

function providerApiUrl(
  provider: Exclude<CloudProviderId, "supabase">,
  pathname: string,
  record: StoredConnection,
): URL {
  const url = new URL(pathname, provider === "vercel" ? "https://api.vercel.com" : "https://api.netlify.com")
  if (provider === "vercel" && record.teamId) url.searchParams.set("teamId", record.teamId)
  return url
}

async function loadProviderIdentity(
  provider: CloudProviderId,
  token: string,
  teamId?: string,
): Promise<{ account?: string; accountId?: string }> {
  if (provider === "vercel") {
    const body = await providerJson(token, "https://api.vercel.com/v2/user")
    const user = body && typeof body === "object" && Reflect.get(body, "user") ? Reflect.get(body, "user") : body
    return {
      account: stringField(user, "username") ?? stringField(user, "name") ?? stringField(user, "email"),
      accountId: teamId ?? stringField(user, "id"),
    }
  }
  if (provider === "netlify") {
    const body = await providerJson(token, "https://api.netlify.com/api/v1/user")
    return {
      account: stringField(body, "full_name") ?? stringField(body, "email"),
      accountId: stringField(body, "id"),
    }
  }
  const body = await providerJson(token, "https://api.supabase.com/v1/organizations")
  const organization = Array.isArray(body) ? body[0] : undefined
  return {
    account: stringField(organization, "name") ?? stringField(organization, "slug") ?? "Supabase account",
    accountId: stringField(organization, "id") ?? stringField(organization, "slug"),
  }
}

async function finishOAuthDeepLink(url: URL): Promise<void> {
  const providerValue = url.searchParams.get("provider")
  if (!isProvider(providerValue)) return
  const flow = activeFlows.get(providerValue)
  if (!flow) throw new Error(`No ${connectionLabel(providerValue)} connection is waiting for approval.`)
  const error = url.searchParams.get("error")
  if (error) throw new Error(error)
  const returnedState = url.searchParams.get("state") ?? ""
  if (!constantTimeEqual(flow.state, returnedState)) {
    throw new Error("The OAuth security state did not match. Start the connection again.")
  }

  let accessToken = ""
  let refreshToken: string | undefined
  let expiresIn: number | undefined
  let teamId = url.searchParams.get("teamId") ?? undefined
  if (providerValue === "netlify") {
    const encrypted = url.searchParams.get("encrypted")
    if (!encrypted || !flow.privateKey) throw new Error("Netlify did not return a secure authorization result.")
    accessToken = privateDecrypt(
      {
        key: flow.privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(encrypted, "base64url"),
    ).toString("utf8")
  } else {
    const code = url.searchParams.get("code")
    if (!code) throw new Error(`${connectionLabel(providerValue)} did not return an authorization code.`)
    const token = await brokerRequest<{
      accessToken: string
      refreshToken?: string
      expiresIn?: number
      teamId?: string
    }>("/exchange", {
      method: "POST",
      body: JSON.stringify({
        provider: providerValue,
        code,
        state: returnedState,
        codeVerifier: flow.codeVerifier,
      }),
    })
    accessToken = token.accessToken
    refreshToken = token.refreshToken
    expiresIn = token.expiresIn
    teamId = token.teamId ?? teamId
  }
  if (!accessToken) throw new Error(`${connectionLabel(providerValue)} did not return an access token.`)

  const identity = await loadProviderIdentity(providerValue, accessToken, teamId).catch(() => ({
    account: connectionLabel(providerValue),
    accountId: teamId,
  }))
  const connectedAt = now()
  saveConnection({
    provider: providerValue,
    accessToken: encryptCloudCredential(accessToken),
    refreshToken: refreshToken ? encryptCloudCredential(refreshToken) : undefined,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
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

export async function disconnectCloudProvider(provider: CloudProviderId): Promise<void> {
  cancelFlow(provider, new Error(`${connectionLabel(provider)} connection was cancelled.`))
  const connection = storedConnection(provider)
  if (provider === "supabase" && connection?.refreshToken) {
    const refreshToken = decryptCloudCredential(connection.refreshToken)
    await brokerRequest("/revoke", {
      method: "POST",
      body: JSON.stringify({ provider, refreshToken }),
    }).catch(() => undefined)
  }
  const records = readConnections().filter((item) => item.provider !== provider)
  writeConnections(records)
  await removeStoreFileIfEmpty(CONNECTION_STORE)
}

async function accessToken(provider: CloudProviderId): Promise<{ token: string; record: StoredConnection }> {
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
    }>("/refresh", {
      method: "POST",
      body: JSON.stringify({ provider: "supabase", refreshToken }),
    })
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

export async function listCloudProviderResources(provider: CloudProviderId): Promise<CloudProviderResource[]> {
  const auth = await accessToken(provider)
  if (provider === "vercel") {
    const url = new URL("https://api.vercel.com/v9/projects")
    url.searchParams.set("limit", "100")
    if (auth.record.teamId) url.searchParams.set("teamId", auth.record.teamId)
    const body = await providerJson(auth.token, url.toString())
    const projects = body && typeof body === "object" ? Reflect.get(body, "projects") : undefined
    if (!Array.isArray(projects)) return []
    return projects
      .map((project): CloudProviderResource | undefined => {
        const id = stringField(project, "id")
        const name = stringField(project, "name")
        if (!id || !name) return
        const targets = Reflect.get(project, "targets")
        const production = targets && typeof targets === "object" ? Reflect.get(targets, "production") : undefined
        return {
          provider,
          id,
          name,
          accountId: auth.record.teamId ?? stringField(project, "accountId"),
          accountName: auth.record.account,
          url: stringField(production, "alias") ? `https://${stringField(production, "alias")}` : undefined,
        }
      })
      .filter((project): project is CloudProviderResource => Boolean(project))
  }
  if (provider === "netlify") {
    const body = await providerJson(auth.token, "https://api.netlify.com/api/v1/sites?per_page=100")
    if (!Array.isArray(body)) return []
    return body
      .map((site): CloudProviderResource | undefined => {
        const id = stringField(site, "id")
        const name = stringField(site, "name")
        if (!id || !name) return
        return {
          provider,
          id,
          name,
          accountId: stringField(site, "account_id"),
          accountName: stringField(site, "account_name") ?? auth.record.account,
          url: stringField(site, "ssl_url") ?? stringField(site, "url"),
          status: stringField(site, "state"),
        }
      })
      .filter((site): site is CloudProviderResource => Boolean(site))
  }
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
    const provider = Reflect.get(value, "provider")
    return (
      (provider === "vercel" || provider === "netlify") &&
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

export async function linkCloudProviderProject(
  projectPath: string,
  taskId: string | undefined,
  provider: Exclude<CloudProviderId, "supabase">,
  projectId: string,
): Promise<CloudProviderProjectLink> {
  if (!projectPath.trim()) throw new Error("Open a project before linking a cloud project.")
  const resource = (await listCloudProviderResources(provider)).find((item) => item.id === projectId)
  if (!resource) throw new Error(`That ${connectionLabel(provider)} project is no longer available.`)
  const link: CloudProviderProjectLink = {
    provider,
    projectId: resource.id,
    projectName: resource.name,
    accountId: resource.accountId,
    accountName: resource.accountName,
    url: resource.url,
    linkedAt: now(),
  }
  const next = [link, ...readLinks(projectPath).filter((item) => item.provider !== provider)]
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

function requireProjectLink(
  projectPath: string,
  taskId: string | undefined,
  provider: Exclude<CloudProviderId, "supabase">,
): CloudProviderProjectLink {
  const link = getCloudProviderProjectLink(projectPath, taskId, provider)
  if (!link) {
    throw new Error(`Link a ${connectionLabel(provider)} project in Connections first.`)
  }
  return link
}

async function netlifySite(
  token: string,
  siteId: string,
): Promise<{ accountId?: string; name?: string; customDomain?: string; aliases: string[] }> {
  const site = await providerJson(token, `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}`)
  const aliases = site && typeof site === "object" ? Reflect.get(site, "domain_aliases") : undefined
  return {
    accountId: stringField(site, "account_id"),
    name: stringField(site, "name"),
    customDomain: stringField(site, "custom_domain"),
    aliases: Array.isArray(aliases) ? aliases.filter((value): value is string => typeof value === "string") : [],
  }
}

export async function syncCloudProviderEnvironment(
  projectPath: string,
  taskId: string | undefined,
  provider: Exclude<CloudProviderId, "supabase">,
): Promise<CloudProviderSyncResult> {
  const link = requireProjectLink(projectPath, taskId, provider)
  const variables = listEnv(projectPath, taskId)
  if (!variables.length) throw new Error("Add at least one environment variable before syncing.")
  const auth = await accessToken(provider)

  if (provider === "vercel") {
    const url = providerApiUrl(provider, `/v10/projects/${encodeURIComponent(link.projectId)}/env`, auth.record)
    url.searchParams.set("upsert", "true")
    await providerJson(auth.token, url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(vercelEnvironmentPayload(variables)),
    })
  } else {
    const site = await netlifySite(auth.token, link.projectId)
    const accountId = link.accountId ?? site.accountId
    if (!accountId) throw new Error("Netlify did not return the account that owns this site.")
    const listUrl = providerApiUrl(provider, `/api/v1/accounts/${encodeURIComponent(accountId)}/env`, auth.record)
    listUrl.searchParams.set("site_id", link.projectId)
    const existing = await providerJson(auth.token, listUrl.toString())
    const existingKeys = new Set(
      Array.isArray(existing)
        ? existing.map((item) => stringField(item, "key")).filter((key): key is string => Boolean(key))
        : [],
    )
    const create = variables.filter((variable) => !existingKeys.has(variable.key))
    if (create.length) {
      await providerJson(auth.token, listUrl.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(netlifyEnvironmentPayload(create)),
      })
    }
    for (const variable of variables.filter((item) => existingKeys.has(item.key))) {
      const updateUrl = providerApiUrl(
        provider,
        `/api/v1/accounts/${encodeURIComponent(accountId)}/env/${encodeURIComponent(variable.key)}`,
        auth.record,
      )
      updateUrl.searchParams.set("site_id", link.projectId)
      await providerJson(auth.token, updateUrl.toString(), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(netlifyEnvironmentPayload([variable])[0]),
      })
    }
  }

  return {
    provider,
    projectId: link.projectId,
    projectName: link.projectName,
    changed: variables.length,
    syncedAt: now(),
    detail: `${variables.length} ${variables.length === 1 ? "variable" : "variables"} synced to ${link.projectName}. Redeploy for the new values to take effect.`,
  }
}

function verificationDetail(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return
  const records = Reflect.get(value, "verification")
  if (!Array.isArray(records)) return
  const instructions = records
    .map((record) => {
      const type = stringField(record, "type")
      const domain = stringField(record, "domain")
      const target = stringField(record, "value")
      if (!type || !domain || !target) return
      return `${type} ${domain} → ${target}`
    })
    .filter((item): item is string => Boolean(item))
  return instructions.length ? `Complete domain verification: ${instructions.join("; ")}` : undefined
}

function recommendedCname(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return
  const recommendation = Reflect.get(value, "recommendedCNAME")
  if (typeof recommendation === "string") return recommendation
  if (Array.isArray(recommendation)) {
    for (const item of recommendation) {
      if (typeof item === "string") return item
      const target = stringField(item, "value") ?? stringField(item, "target")
      if (target) return target
    }
  }
  if (recommendation && typeof recommendation === "object") {
    return stringField(recommendation, "value") ?? stringField(recommendation, "target")
  }
}

export async function addCloudProviderDomain(
  projectPath: string,
  taskId: string | undefined,
  provider: Exclude<CloudProviderId, "supabase">,
  rawDomain: string,
): Promise<CloudDomain> {
  const link = requireProjectLink(projectPath, taskId, provider)
  const domain = normalizeCloudDomain(rawDomain)
  if (listDomains(projectPath, taskId).some((item) => item.domain === domain)) {
    throw new Error(`${domain} is already connected to this project.`)
  }
  const auth = await accessToken(provider)

  if (provider === "vercel") {
    const url = providerApiUrl(provider, `/v10/projects/${encodeURIComponent(link.projectId)}/domains`, auth.record)
    const response = await providerJson(auth.token, url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: domain }),
    })
    const configUrl = providerApiUrl(provider, `/v6/domains/${encodeURIComponent(domain)}/config`, auth.record)
    const config = await providerJson(auth.token, configUrl.toString()).catch(() => undefined)
    const verified = booleanField(response, "verified") === true
    const misconfigured = booleanField(config, "misconfigured")
    return addDomain(projectPath, taskId, {
      domain,
      provider,
      providerProjectId: link.projectId,
      providerProjectName: link.projectName,
      cnameTarget: recommendedCname(config) ?? "cname.vercel-dns.com",
      status: verified && misconfigured === false ? "verified" : "pending",
      detail:
        verificationDetail(response) ??
        (misconfigured === true
          ? "The domain is attached in Vercel. Update its DNS records, then verify again."
          : undefined),
    })
  }

  const site = await netlifySite(auth.token, link.projectId)
  const aliases = addNetlifyDomainAlias(site.aliases, domain)
  await providerJson(auth.token, `https://api.netlify.com/api/v1/sites/${encodeURIComponent(link.projectId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain_aliases: aliases }),
  })
  const target = link.url
    ? new URL(link.url).hostname
    : site.name
      ? `${site.name}.netlify.app`
      : `${link.projectName}.netlify.app`
  return addDomain(projectPath, taskId, {
    domain,
    provider,
    providerProjectId: link.projectId,
    providerProjectName: link.projectName,
    cnameTarget: target,
    status: "pending",
    detail: "The domain is attached in Netlify. Point its CNAME at the target shown, then verify.",
  })
}

export async function verifyCloudProviderDomain(
  projectPath: string,
  taskId: string | undefined,
  id: string,
): Promise<CloudDomain> {
  const domain = listDomains(projectPath, taskId).find((item) => item.id === id)
  if (!domain) throw new Error("That domain is no longer connected to this project.")
  if (domain.provider === "vector-cloud") return verifyDomain(projectPath, taskId, id)
  const provider = domain.provider
  const link = requireProjectLink(projectPath, taskId, provider)
  const auth = await accessToken(provider)
  if (provider === "netlify") return verifyDomain(projectPath, taskId, id)

  const getUrl = providerApiUrl(
    provider,
    `/v9/projects/${encodeURIComponent(link.projectId)}/domains/${encodeURIComponent(domain.domain)}`,
    auth.record,
  )
  let response = await providerJson(auth.token, getUrl.toString())
  if (booleanField(response, "verified") !== true) {
    const verifyUrl = providerApiUrl(
      provider,
      `/v9/projects/${encodeURIComponent(link.projectId)}/domains/${encodeURIComponent(domain.domain)}/verify`,
      auth.record,
    )
    response = await providerJson(auth.token, verifyUrl.toString(), { method: "POST" }).catch(() => response)
  }
  const configUrl = providerApiUrl(provider, `/v6/domains/${encodeURIComponent(domain.domain)}/config`, auth.record)
  const config = await providerJson(auth.token, configUrl.toString()).catch(() => undefined)
  const verified = booleanField(response, "verified") === true
  const misconfigured = booleanField(config, "misconfigured")
  return updateDomainRecord(projectPath, taskId, id, {
    cnameTarget: recommendedCname(config) ?? domain.cnameTarget,
    status: verified && misconfigured === false ? "verified" : "pending",
    detail:
      verificationDetail(response) ??
      (misconfigured === true
        ? "Vercel has the domain, but its DNS records are not configured yet."
        : verified
          ? "Vercel is still checking the domain's DNS configuration."
          : "Vercel still requires domain ownership verification."),
    lastCheckedAt: now(),
  })
}

export async function removeCloudProviderDomain(
  projectPath: string,
  taskId: string | undefined,
  id: string,
): Promise<CloudDomain[]> {
  const domain = listDomains(projectPath, taskId).find((item) => item.id === id)
  if (!domain) return listDomains(projectPath, taskId)
  if (domain.provider === "vector-cloud") return removeDomain(projectPath, taskId, id)
  const provider = domain.provider
  const link = requireProjectLink(projectPath, taskId, provider)
  const auth = await accessToken(provider)

  if (provider === "vercel") {
    const url = providerApiUrl(
      provider,
      `/v9/projects/${encodeURIComponent(link.projectId)}/domains/${encodeURIComponent(domain.domain)}`,
      auth.record,
    )
    await providerJson(auth.token, url.toString(), { method: "DELETE" })
  } else {
    const site = await netlifySite(auth.token, link.projectId)
    await providerJson(auth.token, `https://api.netlify.com/api/v1/sites/${encodeURIComponent(link.projectId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain_aliases: removeNetlifyDomainAlias(site.aliases, domain.domain),
      }),
    })
  }
  return removeDomain(projectPath, taskId, id)
}

export async function connectSupabaseProject(
  projectPath: string,
  taskId: string | undefined,
  projectRef: string,
): Promise<CloudDatabaseConnection> {
  const auth = await accessToken("supabase")
  const projects = await listCloudProviderResources("supabase")
  const project = projects.find((item) => item.id === projectRef)
  if (!project) throw new Error("That Supabase project is no longer available.")
  const keys = await providerJson(
    auth.token,
    `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/api-keys`,
  )
  if (!Array.isArray(keys)) throw new Error("Supabase did not return project API keys.")
  const publicKeyRecord =
    keys.find((item) => stringField(item, "type") === "publishable") ??
    keys.find((item) => stringField(item, "name") === "anon") ??
    keys.find((item) => stringField(item, "type") === "anon")
  const anonKey = stringField(publicKeyRecord, "api_key")
  if (!anonKey) {
    throw new Error("Supabase did not expose a publishable or anon key for this project.")
  }
  return connectDatabase(projectPath, taskId, {
    provider: "supabase",
    url: project.url ?? `https://${projectRef}.supabase.co`,
    anonKey,
    projectRef,
    projectName: project.name,
    managedByOAuth: true,
  })
}

function serviceError(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status === "fulfilled") return
  return result.reason instanceof Error ? result.reason.message : String(result.reason)
}

function responseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object") return []
  const data = Reflect.get(value, "data")
  return Array.isArray(data) ? data : []
}

export async function getSupabaseServiceSnapshot(projectPath: string, taskId?: string): Promise<CloudSupabaseServices> {
  const database = getDatabase(projectPath, taskId)
  const projectRef = database?.projectRef
  if (!database || !projectRef) {
    return {
      connected: false,
      detail: "Connect a Supabase project in Vector Cloud > Database first.",
      storage: { available: false, buckets: [], detail: "No Supabase project is linked." },
      functions: { available: false, functions: [], detail: "No Supabase project is linked." },
    }
  }

  const auth = await accessToken("supabase")
  const [bucketsResult, functionsResult, projectsResult] = await Promise.allSettled([
    providerJson(auth.token, `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/storage/buckets`),
    providerJson(auth.token, `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/functions`),
    listCloudProviderResources("supabase"),
  ])
  const project =
    projectsResult.status === "fulfilled" ? projectsResult.value.find((item) => item.id === projectRef) : undefined
  const bucketValues = bucketsResult.status === "fulfilled" ? responseArray(bucketsResult.value) : []
  const functionValues = functionsResult.status === "fulfilled" ? responseArray(functionsResult.value) : []

  return {
    connected: true,
    projectRef,
    projectName: database.projectName ?? project?.name,
    region: project?.region,
    dashboardUrl: `https://supabase.com/dashboard/project/${encodeURIComponent(projectRef)}`,
    storage: {
      available: bucketsResult.status === "fulfilled",
      detail: serviceError(bucketsResult),
      buckets: bucketValues
        .map((bucket): CloudSupabaseBucket | undefined => {
          const id = stringField(bucket, "id") ?? stringField(bucket, "name")
          const name = stringField(bucket, "name")
          if (!id || !name) return
          return {
            id,
            name,
            public: booleanField(bucket, "public") === true,
            createdAt: stringField(bucket, "created_at"),
            updatedAt: stringField(bucket, "updated_at"),
          }
        })
        .filter((bucket): bucket is CloudSupabaseBucket => Boolean(bucket)),
    },
    functions: {
      available: functionsResult.status === "fulfilled",
      detail: serviceError(functionsResult),
      functions: functionValues
        .map((fn): CloudSupabaseFunction | undefined => {
          const id = stringField(fn, "id") ?? stringField(fn, "slug")
          const name = stringField(fn, "name") ?? stringField(fn, "slug")
          const slug = stringField(fn, "slug") ?? name
          if (!id || !name || !slug) return
          return {
            id,
            name,
            slug,
            status: stringField(fn, "status"),
            version: numberField(fn, "version"),
            createdAt: stringField(fn, "created_at"),
            updatedAt: stringField(fn, "updated_at"),
          }
        })
        .filter((fn): fn is CloudSupabaseFunction => Boolean(fn)),
    },
  }
}
