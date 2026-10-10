import { createHash, timingSafeEqual } from "node:crypto"
import { slugify } from "./shared"

export type CloudClaims = {
  tenant: string
  projects: readonly string[]
}

type CloudCredential = CloudClaims & { token: string }

export class CloudAuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 500,
  ) {
    super(message)
  }
}

export function authorizeCloudRequest(
  request: Request,
  projectHint?: string,
  env: Record<string, string | undefined> = process.env,
) {
  const credentials = cloudCredentials(env)
  const authorization = request.headers.get("authorization") ?? ""
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : ""
  const credential = credentials.find((entry) => tokensEqual(entry.token, token))
  if (!credential) throw new CloudAuthorizationError("Invalid or missing bearer credential.", 401)

  const rawRequested = projectHint || request.headers.get("x-vector-project") || ""
  const requested = rawRequested ? slugify(rawRequested) : ""
  if (!requested && credential.projects.length !== 1) {
    throw new CloudAuthorizationError("Select one authorized project with x-vector-project.", 403)
  }
  const project = requested || credential.projects[0]
  if (!isCloudScope(project) || !credential.projects.includes(project)) {
    throw new CloudAuthorizationError("The bearer credential is not authorized for this project.", 403)
  }
  return { tenant: credential.tenant, project }
}

export function requireCloudCredentials(env: Record<string, string | undefined> = process.env) {
  cloudCredentials(env)
}

export function isCloudScope(value: string) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
}

function cloudCredentials(env: Record<string, string | undefined>): CloudCredential[] {
  const configured = env.VECTOR_CLOUD_CREDENTIALS
  if (configured) return parseCredentials(configured)

  const token = env.VECTOR_CLOUD_TOKEN
  const tenant = env.VECTOR_CLOUD_TENANT
  const project = env.VECTOR_CLOUD_PROJECT
  if (!token || !tenant || !project) {
    throw new CloudAuthorizationError(
      "Configure VECTOR_CLOUD_CREDENTIALS or VECTOR_CLOUD_TOKEN with VECTOR_CLOUD_TENANT and VECTOR_CLOUD_PROJECT.",
      500,
    )
  }
  return validateCredentials([{ token, tenant, projects: [project] }])
}

function parseCredentials(input: string) {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(input)
    } catch {
      throw new CloudAuthorizationError("VECTOR_CLOUD_CREDENTIALS must be valid JSON.", 500)
    }
  })()
  if (!Array.isArray(parsed)) {
    throw new CloudAuthorizationError("VECTOR_CLOUD_CREDENTIALS must be an array.", 500)
  }
  return validateCredentials(
    parsed.map((value) => {
      if (!value || typeof value !== "object") {
        throw new CloudAuthorizationError("Each cloud credential must be an object.", 500)
      }
      const token = Reflect.get(value, "token")
      const tenant = Reflect.get(value, "tenant")
      const projects = Reflect.get(value, "projects")
      if (typeof token !== "string" || typeof tenant !== "string" || !Array.isArray(projects)) {
        throw new CloudAuthorizationError("Each cloud credential needs token, tenant, and projects claims.", 500)
      }
      if (!projects.every((project) => typeof project === "string")) {
        throw new CloudAuthorizationError("Cloud credential projects must be strings.", 500)
      }
      return { token, tenant, projects }
    }),
  )
}

function validateCredentials(credentials: CloudCredential[]) {
  if (!credentials.length) throw new CloudAuthorizationError("Configure at least one cloud credential.", 500)
  const tokenHashes = new Set<string>()
  credentials.forEach((credential) => {
    if (credential.token.length < 16 || credential.token === "local-dev-token") {
      throw new CloudAuthorizationError("Cloud bearer credentials must be explicit and at least 16 characters.", 500)
    }
    if (!isCloudScope(credential.tenant) || !credential.projects.length || !credential.projects.every(isCloudScope)) {
      throw new CloudAuthorizationError("Cloud tenant and project claims must be DNS-label-safe identifiers.", 500)
    }
    if (new Set(credential.projects).size !== credential.projects.length) {
      throw new CloudAuthorizationError("Cloud credential project claims must be unique.", 500)
    }
    const hash = createHash("sha256").update(credential.token).digest("hex")
    if (tokenHashes.has(hash)) throw new CloudAuthorizationError("Cloud bearer credentials must be unique.", 500)
    tokenHashes.add(hash)
  })
  return credentials
}

function tokensEqual(expected: string, actual: string) {
  const expectedHash = createHash("sha256").update(expected).digest()
  const actualHash = createHash("sha256").update(actual).digest()
  return timingSafeEqual(expectedHash, actualHash)
}
