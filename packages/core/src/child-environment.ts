const PRIVATE_RUNTIME_ENVIRONMENT = new Set([
  "BLOB_READ_WRITE_TOKEN",
  "VECTOR_AUTH_CONTENT",
  "VECTOR_CLOUD_TOKEN",
  "VECTOR_CREDENTIAL_KEY",
  "VECTOR_MCP_AUTH_KEY",
  "VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE",
])

const RUNTIME_PRELOAD_ENVIRONMENT = new Set([
  "BASH_ENV",
  "BUN_OPTIONS",
  "CLASSPATH",
  "ENV",
  "GCONV_PATH",
  "JDK_JAVA_OPTIONS",
  "JAVA_TOOL_OPTIONS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PERL5DB",
  "PERL5LIB",
  "PERL5OPT",
  "PYTHONBREAKPOINT",
  "PYTHONHOME",
  "PYTHONINSPECT",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYLIB",
  "RUBYOPT",
  "_JAVA_OPTIONS",
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
  if (RUNTIME_PRELOAD_ENVIRONMENT.has(normalized)) return true
  if (normalized.startsWith("BASH_FUNC_") || normalized.startsWith("LD_") || normalized.startsWith("DYLD_")) return true
  if (normalized.startsWith("LUA_INIT")) return true
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
