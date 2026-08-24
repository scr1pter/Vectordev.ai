import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative } from "node:path"

const MAX_FILE_SIZE = 2 * 1024 * 1024
const MAX_PROJECT_FILES = 2_000
const SKIP_DIRECTORIES = new Set([".git", ".next", ".turbo", ".vercel", "build", "dist", "node_modules", "out"])
const PLACEHOLDER = /(?:change[-_ ]?me|example|fake|placeholder|replace[-_ ]?me|your[-_ ]?(?:key|token|secret)|x{6,})/i
const PATTERNS = [
  { kind: "private key", pattern: /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/g },
  { kind: "AWS access key", pattern: /\bAKIA[A-Z0-9]{16}\b/g },
  { kind: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g },
  { kind: "Stripe secret", pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "provider API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "npm token", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { kind: "Netlify token", pattern: /\bnfp_[A-Za-z0-9]{20,}\b/g },
  { kind: "Supabase token", pattern: /\bsbp_[A-Za-z0-9]{20,}\b/g },
  { kind: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
] as const

export type SecretFinding = {
  file: string
  line: number
  kind: string
}

export async function scanChangedSecrets(sourcePath: string, isolatedPath: string, files: string[]) {
  const findings = (
    await Promise.all(
      files.map(async (file) => {
        const isolated = await readText(join(isolatedPath, file))
        if (!isolated) return []
        const source = await readText(join(sourcePath, file))
        const existing = new Set(source ? matches(source).map((item) => item.fingerprint) : [])
        return matches(isolated)
          .filter((item) => !existing.has(item.fingerprint))
          .map((item): SecretFinding => ({ file, line: item.line, kind: item.kind }))
      }),
    )
  ).flat()
  return findings.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

// `reportRoot` exists so publish can scan the built output as a second root: the
// findings still have to name a path the user recognises inside their project
// ("dist/assets/index-a1b2.js"), not one relative to the build directory.
export async function scanProjectSecrets(projectPath: string, reportRoot = projectPath) {
  const files: string[] = []
  const walk = async (directory: string): Promise<void> => {
    if (files.length >= MAX_PROJECT_FILES) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    await Promise.all(
      entries.map(async (entry) => {
        if (files.length >= MAX_PROJECT_FILES) return
        if (entry.isDirectory()) {
          if (SKIP_DIRECTORIES.has(entry.name)) return
          await walk(join(directory, entry.name))
          return
        }
        if (!entry.isFile() || entry.name.startsWith(".env")) return
        files.push(join(directory, entry.name))
      }),
    )
  }
  await walk(projectPath)
  const findings = (
    await Promise.all(
      files.map(async (file) => {
        const content = await readText(file)
        if (!content) return []
        return matches(content).map(
          (item): SecretFinding => ({
            file: relative(reportRoot, file).split("\\").join("/"),
            line: item.line,
            kind: item.kind,
          }),
        )
      }),
    )
  ).flat()
  return findings.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

async function readText(file: string) {
  const info = await stat(file).catch(() => undefined)
  if (!info?.isFile() || info.size > MAX_FILE_SIZE) return undefined
  const content = await readFile(file).catch(() => undefined)
  if (!content || content.includes(0)) return undefined
  return content.toString("utf8")
}

function matches(content: string) {
  return content.split(/\r?\n/).flatMap((line, index) => {
    if (PLACEHOLDER.test(line)) return []
    return PATTERNS.flatMap(({ kind, pattern }) =>
      Array.from(line.matchAll(pattern))
        .filter((match) => kind !== "JWT" || !isPublicClientJwt(match[0]))
        .map((match) => ({
          kind,
          line: index + 1,
          fingerprint: createHash("sha256").update(`${kind}:${match[0]}`).digest("hex"),
        })),
    )
  })
}

// A Supabase anon key is a JWT that belongs in the client bundle by design, and
// the Cloud Console writes one into every project it connects to a database.
// Without this the deploy-output scan would fail the release gate on every
// Supabase app — which teaches users to switch the gate off. The `service_role`
// key has the same shape and is the leak actually worth blocking, so only the
// public roles are excused.
function isPublicClientJwt(token: string) {
  const payload = Buffer.from(token.split(".")[1], "base64url").toString("utf8")
  return /"role"\s*:\s*"(?:anon|authenticated)"/.test(payload)
}
