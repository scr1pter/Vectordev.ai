import { createPrivateKey } from "node:crypto"
import { importPKCS8, SignJWT } from "jose"
import { ApiError } from "./http.js"
import {
  githubApiVersion,
  githubId,
  githubRecord,
  githubResponseBytes,
  githubUnavailable,
  type GithubRequest,
} from "./github-http.js"
import type { GithubIdentity } from "./github-oidc.js"

export const githubTokenPermissions = {
  task: {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    actions: "write",
    checks: "read",
    metadata: "read",
  },
  review: { contents: "read", pull_requests: "write", issues: "write", checks: "read", metadata: "read" },
} as const
export type GithubTokenPurpose = keyof typeof githubTokenPermissions
export type GithubTokenResult = {
  token: string
  expiresAt: string
  repositoryId: string
  repository: string
  permissions: (typeof githubTokenPermissions)[GithubTokenPurpose]
  bot: { login: string; id: number }
}
export type GithubAppConfiguration = { id: string; clientId: string; slug: string; privateKey: string }
const validationPermissions = {
  contents: "read",
  actions: "read",
  pull_requests: "read",
  checks: "read",
  metadata: "read",
} as const
const githubApi = "https://api.github.com"

export function githubAppConfiguration(
  env: Record<string, string | undefined> = process.env,
): GithubAppConfiguration | undefined {
  if (env.VECTOR_GITHUB_APP_ENABLED !== "true" || (env.VERCEL_ENV && env.VERCEL_ENV !== "production")) return undefined
  const id = env.VECTOR_GITHUB_APP_ID ?? ""
  const clientId = env.VECTOR_GITHUB_APP_CLIENT_ID ?? ""
  const slug = env.VECTOR_GITHUB_APP_SLUG ?? ""
  const privateKey = (env.VECTOR_GITHUB_APP_PRIVATE_KEY ?? "").replaceAll("\\n", "\n")
  if (
    !/^[1-9]\d{0,15}$/.test(id) ||
    BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(clientId) ||
    !/^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$/.test(slug) ||
    privateKey.length > 16_384 ||
    !/^-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(privateKey)
  )
    throw notConfigured()
  return { id, clientId, slug, privateKey }
}

export function createGithubApp(
  input: {
    configuration?: () => GithubAppConfiguration | undefined
    request?: GithubRequest
  } = {},
) {
  const configuration = input.configuration ?? githubAppConfiguration
  const request = input.request ?? fetch

  async function api(
    pathname: string,
    token?: string,
    options: { method?: string; body?: unknown; missing?: boolean } = {},
  ) {
    if (!pathname.startsWith("/") || pathname.startsWith("//")) throw githubUnavailable()
    const response = await request(`${githubApi}${pathname}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": githubApiVersion,
        "user-agent": "Vector-GitHub-App",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    }).catch(() => {
      throw githubUnavailable()
    })
    if (response.status === 404 && options.missing) {
      await response.body?.cancel()
      return undefined
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw githubUnavailable()
    }
    if (response.status === 204) {
      await response.body?.cancel()
      return undefined
    }
    const bytes = await githubResponseBytes(response)
    try {
      return githubRecord(JSON.parse(Buffer.from(bytes).toString("utf8")))
    } catch {
      throw githubUnavailable()
    }
  }

  async function appJwt(config: GithubAppConfiguration) {
    const key = (() => {
      try {
        const privateKey = createPrivateKey(config.privateKey)
        if (privateKey.asymmetricKeyType !== "rsa" || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
          throw notConfigured()
        return privateKey.export({ type: "pkcs8", format: "pem" }).toString()
      } catch {
        throw notConfigured()
      }
    })()
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(config.clientId)
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 300)
      .sign(await importPKCS8(key, "RS256"))
      .catch(() => {
        throw notConfigured()
      })
  }

  async function revoke(token: string) {
    await api("/installation/token", token, { method: "DELETE" })
  }

  async function mint(
    jwt: string,
    installationId: string,
    identity: GithubIdentity,
    permissions: Record<string, string>,
  ) {
    const result = await api(`/app/installations/${installationId}/access_tokens`, jwt, {
      method: "POST",
      body: { repository_ids: [Number(identity.repositoryId)], permissions },
    })
    const token = result?.token
    if (typeof token !== "string" || !/^[A-Za-z0-9_]{20,2048}$/.test(token)) throw githubUnavailable()
    try {
      const expiresAt = result!.expires_at
      if (
        typeof expiresAt !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(expiresAt) ||
        !Number.isFinite(Date.parse(expiresAt)) ||
        Date.parse(expiresAt) <= Date.now() ||
        Date.parse(expiresAt) > Date.now() + 3_660_000
      )
        throw githubUnavailable()
      const granted = githubRecord(result!.permissions)
      if (
        Object.keys(granted).length !== Object.keys(permissions).length ||
        Object.entries(permissions).some(([key, value]) => granted[key] !== value)
      )
        throw githubUnavailable()
      // The create response does not always include repository objects. Verify
      // actual access with the new token before it can leave the server.
      const scope = await api("/installation/repositories?per_page=2", token)
      if (scope?.total_count !== 1 || !Array.isArray(scope.repositories) || scope.repositories.length !== 1)
        throw githubUnavailable()
      const repository = githubRecord(scope.repositories[0])
      if (
        githubId(repository.id) !== identity.repositoryId ||
        repository.full_name !== identity.repository ||
        githubId(githubRecord(repository.owner).id) !== identity.ownerId
      )
        throw githubUnavailable()
      return { token, expiresAt }
    } catch (error) {
      await revoke(token)
      throw error
    }
  }

  async function authorize(identity: GithubIdentity, purpose?: GithubTokenPurpose, pullRequest?: number) {
    const config = configuration()
    if (!config) throw notConfigured()
    const jwt = await appJwt(config)
    const metadata = await api("/app", jwt)
    if (githubId(metadata?.id) !== config.id || metadata?.slug !== config.slug) throw notConfigured()
    const root = `/repos/${identity.repository}`
    const installation = await api(`${root}/installation`, jwt, { missing: true })
    if (!installation)
      return { installed: false as const, installUrl: installUrl(config), repositoryId: identity.repositoryId }
    if (
      githubId(installation.app_id) !== config.id ||
      githubId(githubRecord(installation.account).id) !== identity.ownerId ||
      installation.suspended_at !== null
    )
      throw denied("REPOSITORY_MISMATCH", "This repository's App installation is unavailable.")
    const installationId = githubId(installation.id)
    const validation = await mint(jwt, installationId, identity, validationPermissions)
    try {
      const repository = await api(root, validation.token)
      if (
        githubId(repository?.id) !== identity.repositoryId ||
        repository?.full_name !== identity.repository ||
        githubId(githubRecord(repository.owner).id) !== identity.ownerId ||
        repository.archived === true ||
        repository.disabled === true
      )
        throw denied("REPOSITORY_MISMATCH", "The repository identity no longer matches this workflow.")
      if (typeof repository.default_branch !== "string" || identity.ref !== `refs/heads/${repository.default_branch}`)
        throw denied("WORKFLOW_NOT_TRUSTED", "Use the Vector workflow on the repository's current default branch.")
      const run = await api(`${root}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`, validation.token)
      if (
        githubId(run?.id) !== identity.runId ||
        githubId(run?.run_attempt) !== identity.runAttempt ||
        run?.event !== identity.event ||
        run?.head_sha !== identity.sha ||
        run?.head_branch !== repository.default_branch ||
        run?.status !== "in_progress" ||
        githubId(githubRecord(run.repository).id) !== identity.repositoryId ||
        githubId(githubRecord(run.head_repository).id) !== identity.repositoryId ||
        run.path !== ".github/workflows/vector.yml"
      )
        throw denied("WORKFLOW_NOT_TRUSTED", "This workflow run is not an active trusted Vector job.")
      const workflow = await api(`${root}/actions/workflows/${githubId(run.workflow_id)}`, validation.token)
      if (
        githubId(workflow?.id) !== githubId(run.workflow_id) ||
        workflow?.path !== ".github/workflows/vector.yml" ||
        workflow?.state !== "active"
      )
        throw denied("WORKFLOW_NOT_TRUSTED", "The default-branch Vector workflow is not active.")
      const actor = githubRecord(run.actor)
      if (githubId(actor.id) !== identity.actorId || actor.login !== identity.actor || actor.type !== "User")
        throw denied("ACTOR_NOT_ALLOWED", "The workflow actor is not authorized for App credentials.")
      for (const user of [actor, githubRecord(run.triggering_actor)]) {
        if (
          user.type !== "User" ||
          typeof user.login !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login)
        )
          throw denied("ACTOR_NOT_ALLOWED", "Only authorized people can trigger elevated Vector jobs.")
        const permission = await api(`${root}/collaborators/${user.login}/permission`, validation.token)
        const checked = githubRecord(permission?.user)
        if (
          githubId(checked.id) !== githubId(user.id) ||
          checked.login !== user.login ||
          !["admin", "maintain", "write"].includes(String(permission?.permission))
        )
          throw denied("ACTOR_NOT_ALLOWED", "The workflow actor no longer has repository write permission.")
      }
      const jobs: Record<string, unknown>[] = []
      for (let page = 1; page <= 5; page++) {
        const result = await api(
          `${root}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}/jobs?per_page=100&page=${page}`,
          validation.token,
        )
        if (
          !Array.isArray(result?.jobs) ||
          !Number.isSafeInteger(result.total_count) ||
          Number(result.total_count) > 500 ||
          result.jobs.length > 100
        )
          throw denied("WORKFLOW_NOT_TRUSTED", "The workflow job list cannot be verified.")
        jobs.push(...result.jobs.map(githubRecord))
        if (jobs.length >= Number(result.total_count)) break
      }
      const matching = jobs.filter(
        (job) => job.check_run_url === `${githubApi}${root}/check-runs/${identity.checkRunId}`,
      )
      const job = matching[0]
      const profile = job?.name === "Vector task" ? "task" : job?.name === "Vector review" ? "review" : undefined
      if (
        matching.length !== 1 ||
        !profile ||
        (purpose && profile !== purpose) ||
        job?.status !== "in_progress" ||
        githubId(job.run_id) !== identity.runId ||
        job.head_sha !== identity.sha ||
        job.head_branch !== repository.default_branch
      )
        throw denied("WORKFLOW_NOT_TRUSTED", "The identity token does not belong to the expected active Vector job.")
      if (!Array.isArray(run.pull_requests) || run.pull_requests.length > 20) throw githubUnavailable()
      const numbers = new Set(run.pull_requests.map((pr) => Number(githubId(githubRecord(pr).number))))
      if (pullRequest !== undefined) numbers.add(pullRequest)
      for (const number of numbers) {
        const pr = await api(`${root}/pulls/${number}`, validation.token)
        if (
          githubId(pr?.number) !== String(number) ||
          githubId(githubRecord(githubRecord(pr?.base).repo).id) !== identity.repositoryId ||
          githubId(githubRecord(githubRecord(pr?.head).repo).id) !== identity.repositoryId
        )
          throw denied("EVENT_NOT_ALLOWED", "Fork pull requests use the existing GitHub-token review path.")
      }
    } finally {
      // Never retain the private-repository validation credential in the server.
      // Failure to revoke stops issuance of the final write credential.
      await revoke(validation.token)
    }
    const bot = await api(`/users/${config.slug}%5Bbot%5D`)
    if (bot?.login !== `${config.slug}[bot]` || bot?.type !== "Bot") throw notConfigured()
    return {
      installed: true as const,
      repositoryId: identity.repositoryId,
      repository: identity.repository,
      installUrl: installUrl(config),
      installationId,
      jwt,
      bot: { login: bot.login, id: Number(githubId(bot.id)) },
    }
  }

  return {
    configuration() {
      const config = configuration()
      return config ? { available: true, installUrl: installUrl(config) } : { available: false }
    },
    async installation(identity: GithubIdentity) {
      const authorized = await authorize(identity)
      return {
        installed: authorized.installed,
        repositoryId: identity.repositoryId,
        installUrl: authorized.installUrl,
        ...(!authorized.installed ? { retryAfterSeconds: 10 } : {}),
      }
    },
    async token(
      identity: GithubIdentity,
      purpose: GithubTokenPurpose,
      pullRequest: number | undefined,
      beforeMint: () => Promise<void>,
    ): Promise<GithubTokenResult> {
      const authorized = await authorize(identity, purpose, pullRequest)
      if (!authorized.installed)
        throw new ApiError(404, "APP_NOT_INSTALLED", "Install the Vector GitHub App on this repository first.")
      await beforeMint()
      const token = await mint(authorized.jwt, authorized.installationId, identity, githubTokenPermissions[purpose])
      return {
        ...token,
        repositoryId: identity.repositoryId,
        repository: identity.repository,
        permissions: githubTokenPermissions[purpose],
        bot: authorized.bot,
      }
    },
  }
}

function installUrl(config: GithubAppConfiguration) {
  return `https://github.com/apps/${config.slug}/installations/new`
}
function denied(code: string, message: string) {
  return new ApiError(403, code, message)
}
function notConfigured() {
  return new ApiError(
    503,
    "GITHUB_APP_NOT_CONFIGURED",
    "Vector GitHub App authentication is not enabled or configured.",
  )
}

export const githubApp = createGithubApp()
