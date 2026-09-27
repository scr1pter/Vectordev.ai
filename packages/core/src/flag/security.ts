import { legacyPrefix } from "./legacy"

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

/**
 * Refuse to discard a security setting the earlier product's variable still carries.
 * Only that product's exact prefix counts; other tools' *_SERVER_PASSWORD and similar
 * variables are theirs, not Vector settings.
 */
export function assertSecurityEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const messages = securitySuffixes.flatMap((suffix) => {
    const key = `${legacyPrefix}${suffix}`
    if (!legacyPrefix || env[key] === undefined || env[`VECTOR_${suffix}`]) return []
    return [`Found ${key}; Vector only reads VECTOR_${suffix}. Rename the variable or explicitly set VECTOR_${suffix}.`]
  })
  if (messages.length) throw new SecurityConfigurationError(messages.join("\n"))
}
