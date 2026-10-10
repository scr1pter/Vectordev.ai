const PRIVATE_RUNTIME_ENVIRONMENT = new Set([
  "BLOB_READ_WRITE_TOKEN",
  "VECTOR_AUTH_CONTENT",
  "VECTOR_CLOUD_TOKEN",
  "VECTOR_CREDENTIAL_KEY",
  "VECTOR_MCP_AUTH_KEY",
  "VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE",
])

/**
 * Builds an environment for project-controlled or otherwise untrusted child
 * processes without exposing Vector's in-process vault and bridge secrets.
 * Filtering is case-insensitive because Windows environment keys are too.
 *
 * Only Vector's own secrets are removed. The user's variables, including
 * NODE_OPTIONS, PYTHONPATH and LD_LIBRARY_PATH, reach their commands unchanged;
 * preload variables a project config tries to set are refused when that
 * config is loaded (WorkspaceTrust.unsafeProjectEnvironment).
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
  if (/^[A-Z0-9_]+_(?:AUTH_CONTENT|CONSOLE_TOKEN|SERVER_PASSWORD|SERVER_GUEST_PASSWORD)$/.test(normalized)) return true
  if (!normalized.startsWith("VECTOR_")) return false
  return (
    normalized.endsWith("_TOKEN") ||
    normalized.endsWith("_KEY") ||
    normalized.endsWith("_PASSWORD") ||
    normalized.endsWith("_SECRET")
  )
}

export * as ChildEnvironment from "./child-environment"
