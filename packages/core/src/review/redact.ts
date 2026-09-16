// Removes secrets from everything Vector posts: values of secret-looking environment variables, and well-known token
// shapes that may not be in the environment at all. Pure and browser-safe.

export const REDACTED = "[redacted]"

const SECRET_NAME = /_(?:TOKEN|KEY|SECRET|PASSWORD)$/i
const MIN_LENGTH = 12

const TOKEN_SHAPES = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
]

// Values of `*_TOKEN`, `*_KEY`, `*_SECRET` and `*_PASSWORD` variables of 12 characters or more, longest first so a
// secret that contains another is replaced whole. Shorter values would match ordinary words.
export function collectSecretValues(env: Record<string, string | undefined>): string[] {
  const values = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_NAME.test(name)) continue
    const trimmed = value.trim()
    if (trimmed.length >= MIN_LENGTH) values.add(trimmed)
    // A multi-line value, such as a private key, can leak one line at a time.
    for (const line of trimmed.split(/\r?\n/)) {
      const part = line.trim()
      if (part.length >= MIN_LENGTH && !part.startsWith("-----")) values.add(part)
    }
  }
  return [...values].sort((a, b) => b.length - a.length)
}

export function redactSecrets(text: string, values: string[]): string {
  let out = text
  for (const value of values) if (value.length >= MIN_LENGTH) out = out.split(value).join(REDACTED)
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED)
  return out
}
