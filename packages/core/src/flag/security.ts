const securitySuffixes = [
  "SERVER_PASSWORD",
  "SERVER_USERNAME",
  "SERVER_GUEST_PASSWORD",
  "SERVER_GUEST_USERNAME",
  "PERMISSION",
  "PURE",
  "DISABLE_PROJECT_CONFIG",
  "SHELL_SANDBOX",
  "CONFIG_CONTENT",
] as const

export class SecurityConfigurationError extends Error {
  override readonly name = "SecurityConfigurationError"
}

/** Refuse to discard a security setting from a differently named environment. */
export function assertSecurityEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const messages = Object.keys(env).flatMap((key) => {
    if (key.startsWith("VECTOR_") || env[key] === undefined) return []
    const suffix = securitySuffixes.find((suffix) => key.toUpperCase().endsWith(`_${suffix}`))
    if (!suffix || env[`VECTOR_${suffix}`]) return []
    return [`Found ${key}; Vector only reads VECTOR_${suffix}. Rename the variable or explicitly set VECTOR_${suffix}.`]
  })
  if (messages.length) throw new SecurityConfigurationError(messages.join("\n"))
}
