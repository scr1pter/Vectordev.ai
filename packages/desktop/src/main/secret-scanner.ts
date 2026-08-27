import { createHash } from "node:crypto"
import { isUtf8 } from "node:buffer"
import { open, readdir, readFile, stat } from "node:fs/promises"
import { join, relative } from "node:path"

const MAX_FILE_SIZE = 2 * 1024 * 1024
const MAX_PROJECT_FILES = 2_000
const SKIP_DIRECTORIES = new Set([".git", ".next", ".turbo", ".vercel", "build", "dist", "node_modules", "out"])
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
        if (isolated.incomplete) return [{ file, line: 0, kind: isolated.incomplete }]
        if (!isolated.content) return []
        const source = await readText(join(sourcePath, file))
        if (source.incomplete) return [{ file, line: 0, kind: source.incomplete }]
        const existing = new Set(source.content ? matches(source.content).map((item) => item.fingerprint) : [])
        return matches(isolated.content)
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
  const traversalFindings: SecretFinding[] = []
  let truncated = false
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)
    if (!entries) {
      traversalFindings.push({
        file: relative(reportRoot, directory).split("\\").join("/") || ".",
        line: 0,
        kind: "secret scan incomplete: directory could not be read",
      })
      return
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        await walk(join(directory, entry.name))
        if (truncated) return
        continue
      }
      if (!entry.isFile() || entry.name.startsWith(".env")) continue
      if (files.length >= MAX_PROJECT_FILES) {
        truncated = true
        return
      }
      files.push(join(directory, entry.name))
    }
  }
  await walk(projectPath)
  const findings = (
    await Promise.all(
      files.map(async (file) => {
        const scanned = await readText(file)
        const reported = relative(reportRoot, file).split("\\").join("/")
        if (scanned.incomplete) return [{ file: reported, line: 0, kind: scanned.incomplete }]
        if (!scanned.content) return []
        return matches(scanned.content).map(
          (item): SecretFinding => ({
            file: reported,
            line: item.line,
            kind: item.kind,
          }),
        )
      }),
    )
  ).flat()
  return [
    ...traversalFindings,
    ...findings,
    ...(truncated
      ? [
          {
            file: relative(reportRoot, projectPath).split("\\").join("/") || ".",
            line: 0,
            kind: `secret scan incomplete: more than ${MAX_PROJECT_FILES.toLocaleString("en-US")} files`,
          },
        ]
      : []),
  ].toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

async function readText(file: string) {
  const result = await stat(file).then(
    (info) => ({ info }),
    (error: NodeJS.ErrnoException) => ({ error }),
  )
  if ("error" in result) {
    if (result.error.code === "ENOENT") return {}
    return { incomplete: "secret scan incomplete: file metadata could not be read" }
  }
  if (!result.info.isFile()) return {}
  if (result.info.size > MAX_FILE_SIZE) {
    const prefix = await readPrefix(file).catch(() => undefined)
    if (!prefix) return { incomplete: "secret scan incomplete: file could not be read" }
    if (prefix.includes(0) || !isUtf8(prefix)) return {}
    return { incomplete: `secret scan incomplete: file exceeds ${MAX_FILE_SIZE / (1024 * 1024)} MB` }
  }
  const content = await readFile(file).catch(() => undefined)
  if (!content) return { incomplete: "secret scan incomplete: file could not be read" }
  if (content.includes(0)) return {}
  return { content: content.toString("utf8") }
}

async function readPrefix(file: string) {
  const handle = await open(file, "r")
  const buffer = Buffer.alloc(8 * 1024)
  return handle
    .read(buffer, 0, buffer.length, 0)
    .then((result) => result.buffer.subarray(0, result.bytesRead))
    .finally(() => handle.close())
}

function matches(content: string) {
  return content.split(/\r?\n/).flatMap((line, index) => {
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
// anonymous browser role is excused.
function isPublicClientJwt(token: string) {
  const payload = (() => {
    try {
      return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
        iss?: unknown
        ref?: unknown
        role?: unknown
      }
    } catch {
      return undefined
    }
  })()
  // Supabase's anonymous browser key is intentionally public. `authenticated`
  // is a user session and must never receive the same exemption. Requiring the
  // Supabase issuer and project reference also prevents an unrelated JWT from
  // bypassing the scanner merely by claiming a public-looking role.
  return (
    payload?.iss === "supabase" && payload.role === "anon" && typeof payload.ref === "string" && payload.ref.length > 0
  )
}
