const PRIVATE_RUNTIME_ENVIRONMENT = new Set([
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_CONSOLE_TOKEN",
  "OPENCODE_SERVER_PASSWORD",
  "VECTOR_CLOUD_TOKEN",
  "VECTOR_CREDENTIAL_KEY",
  "VECTOR_MCP_AUTH_KEY",
  "VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE",
])

/**
 * Builds an environment for project-controlled or otherwise untrusted child
 * processes without exposing Vector's in-process vault and bridge secrets.
 * Filtering is case-insensitive because Windows environment keys are too.
 */
export function untrustedChildEnvironment(...sources: Array<NodeJS.ProcessEnv | undefined>) {
  const environment: NodeJS.ProcessEnv = Object.assign(
    {},
    ...(sources.length ? sources.filter(Boolean) : [process.env]),
  )
  return Object.fromEntries(
    Object.entries(environment).flatMap(([key, value]) =>
      typeof value === "string" && !privateRuntimeKey(key) ? [[key, value] as const] : [],
    ),
  )
}

function privateRuntimeKey(key: string) {
  const normalized = key.toUpperCase()
  if (PRIVATE_RUNTIME_ENVIRONMENT.has(normalized)) return true
  if (!normalized.startsWith("VECTOR_")) return false
  return (
    normalized.endsWith("_TOKEN") ||
    normalized.endsWith("_KEY") ||
    normalized.endsWith("_PASSWORD") ||
    normalized.endsWith("_SECRET")
  )
}

export * as ChildEnvironment from "./child-environment"
