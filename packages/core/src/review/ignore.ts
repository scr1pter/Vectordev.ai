// Which changed files a review leaves out (lockfiles, build output, vendored and generated code, binaries and the
// repository's own ignore globs), and which paths make a change security-sensitive. Pure and browser-safe.

import { minimatch } from "minimatch"
import type { DiffFile } from "./diff"
import type { ReviewConfig, SkippedFile } from "./types"

export const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "composer.lock",
  "Gemfile.lock",
  "flake.lock",
  "Podfile.lock",
  "pubspec.lock",
  "mix.lock",
  "packages.lock.json",
]

// `build`, `out` and `vendor` count only at the repository root, so `src/build/x.ts` is still reviewed.
export const DEFAULT_IGNORES: { glob: string; reason: SkippedFile["reason"] }[] = [
  { glob: "**/dist/**", reason: "build-output" },
  { glob: "**/.next/**", reason: "build-output" },
  { glob: "**/coverage/**", reason: "build-output" },
  { glob: "**/node_modules/**", reason: "vendored" },
  { glob: "**/__snapshots__/**", reason: "generated" },
  { glob: "**/__generated__/**", reason: "generated" },
  { glob: "build/**", reason: "build-output" },
  { glob: "out/**", reason: "build-output" },
  { glob: "vendor/**", reason: "vendored" },
  { glob: "**/*.min.js", reason: "build-output" },
  { glob: "**/*.min.css", reason: "build-output" },
  { glob: "**/*.map", reason: "build-output" },
  { glob: "**/*.snap", reason: "generated" },
  { glob: "**/*.pb.go", reason: "generated" },
  { glob: "**/*_pb2.py", reason: "generated" },
  { glob: "**/*.generated.*", reason: "generated" },
]

// Names that mark generated code on their own. A new file with a generated header is skipped only under one of these,
// so a pull request cannot hide new code by adding a header to it.
const GENERATED_NAMES = [
  "**/*.generated.*",
  "**/*.pb.go",
  "**/*_pb2.py",
  "**/__generated__/**",
  "**/__snapshots__/**",
  "**/*.snap",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
]

const GENERATED_HEADER = [/@generated/, /DO NOT EDIT/, /^\/\/ Code generated .* DO NOT EDIT\.$/]

const BINARY_EXTENSIONS = new Set(
  (
    "png jpg jpeg gif bmp ico icns webp avif tif tiff psd heic " +
    "pdf zip gz tgz bz2 xz zst 7z rar tar jar war ear " +
    "exe dll so dylib a lib o obj class pyc pyo wasm bin dat node dmg iso apk aab ipa " +
    "woff woff2 ttf otf eot mp3 mp4 m4a m4v mov avi mkv webm wav flac ogg " +
    "sqlite sqlite3 db p12 pfx jks keystore"
  ).split(" "),
)

const CODE_EXTENSIONS = new Set(
  (
    "ts tsx mts cts js jsx mjs cjs vue svelte astro py pyi go rs java kt kts scala groovy rb php cs fs " +
    "c h cc cpp cxx hpp hh m mm swift dart ex exs erl elm clj hs lua pl r jl sh bash zsh ps1 sql graphql proto sol"
  ).split(" "),
)

// Path words that suggest trust boundaries, secrets or data access. Matched as whole words of the path, so
// "tokenizer.ts" is not sensitive and "sessionStore.ts" is.
const SENSITIVE_WORDS = new Set(
  (
    "auth authn authz authenticate authentication authorize authorization oauth oidc saml sso login logout " +
    "signin signup session cookie token jwt jwk password passwd secret credential crypto cipher encrypt decrypt " +
    "hmac permission acl rbac iam policy security sanitize sanitizer csrf xss cors csp sql db database migration " +
    "payment billing invoice stripe webhook upload admin mfa otp totp cert certificate tls ssl keychain keystore " +
    "vault kms deserialize middleware firewall sandbox"
  ).split(" "),
)

const SENSITIVE_PATHS = [
  ".github/workflows/**",
  ".github/actions/**",
  "**/Dockerfile*",
  "**/*.dockerfile",
  "**/docker-compose*.{yml,yaml}",
  "**/*.tf",
  "**/*.tfvars",
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/.npmrc",
  "**/*.sql",
]

const DOC_EXTENSIONS = new Set(["md", "mdx", "markdown", "txt", "rst", "adoc"])

function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1)
}

function extension(path: string) {
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1) : ""
}

export function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(extension(path))
}

export function isCodePath(path: string): boolean {
  return CODE_EXTENSIONS.has(extension(path))
}

// Whether a change to this path should bring in the security specialist when `security` is "auto".
export function isSensitivePath(path: string): boolean {
  if (SENSITIVE_PATHS.some((glob) => minimatch(path, glob, { dot: true, nocase: true }))) return true
  const ext = extension(path)
  if (DOC_EXTENSIONS.has(ext) || BINARY_EXTENSIONS.has(ext)) return false
  const words = path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  return words.some(
    (word) =>
      SENSITIVE_WORDS.has(word) || (word.length > 4 && word.endsWith("s") && SENSITIVE_WORDS.has(word.slice(0, -1))),
  )
}

// A generated-code marker in the first 5 lines.
export function hasGeneratedHeader(text: string): boolean {
  return text.split("\n", 5).some((line) => GENERATED_HEADER.some((pattern) => pattern.test(line.replace(/\r$/, ""))))
}

export interface GitAttributes {
  generated(path: string): boolean
  vendored(path: string): boolean
}

// Reads `linguist-generated` and `linguist-vendored` from a .gitattributes file. The last matching line wins; a
// pattern without a slash matches the file name at any depth, as in git.
export function parseGitAttributes(text: string): GitAttributes {
  const rules: { pattern: string; anchored: boolean; attributes: Map<string, boolean | undefined> }[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith("[attr]") || line.startsWith("!")) continue
    const [pattern, ...tokens] = line.split(/\s+/)
    // Attributes apply to files, so a directory pattern ("vendor/") matches nothing, as in git.
    if (pattern.endsWith("/")) continue
    const attributes = new Map<string, boolean | undefined>()
    for (const token of tokens) {
      if (token.startsWith("-")) attributes.set(token.slice(1), false)
      else if (token.startsWith("!")) attributes.set(token.slice(1), undefined)
      else {
        const equals = token.indexOf("=")
        if (equals < 0) attributes.set(token, true)
        else
          attributes.set(token.slice(0, equals), !["false", "0", "no"].includes(token.slice(equals + 1).toLowerCase()))
      }
    }
    rules.push({ pattern: pattern.replace(/^\//, ""), anchored: pattern.includes("/"), attributes })
  }
  const state = (path: string, name: string) => {
    let value: boolean | undefined
    for (const rule of rules) {
      if (!rule.attributes.has(name)) continue
      const target = rule.anchored ? path : basename(path)
      if (minimatch(target, rule.pattern, { dot: true })) value = rule.attributes.get(name)
    }
    return value === true
  }
  return {
    generated: (path) => state(path, "linguist-generated"),
    vendored: (path) => state(path, "linguist-vendored"),
  }
}

export interface ClassifyOptions {
  config: Pick<ReviewConfig, "ignore" | "ignoreDefaults">
  attributes?: GitAttributes // from the base commit's .gitattributes
}

// Why a path is left out of review, from its name alone, or undefined when it is reviewed. The repository's own
// .gitattributes and binaries apply even with `ignoreDefaults: false`.
export function classifyPath(path: string, options: ClassifyOptions): SkippedFile["reason"] | undefined {
  const { config, attributes } = options
  if (config.ignoreDefaults) {
    if (LOCKFILES.includes(basename(path))) return "lockfile"
    const rule = DEFAULT_IGNORES.find((item) => minimatch(path, item.glob, { dot: true }))
    if (rule) return rule.reason
  }
  if (attributes?.generated(path)) return "generated"
  if (attributes?.vendored(path)) return "vendored"
  if (isBinaryPath(path)) return "binary"
  if (config.ignore.some((glob) => minimatch(path, glob, { dot: true }))) return "ignored"
  return undefined
}

// Splits a diff into the files to review and the ones to list under "Not reviewed". New code files that a path rule
// skipped come first, with their added-line counts, so code hidden under an ignored path stays visible.
export function classifyFiles(
  files: DiffFile[],
  options: ClassifyOptions,
): { review: DiffFile[]; skipped: SkippedFile[] } {
  const review: DiffFile[] = []
  const hidden: SkippedFile[] = []
  const rest: SkippedFile[] = []
  for (const file of files) {
    const byPath = classifyPath(file.path, options)
    const reason =
      byPath ?? (file.binary ? "binary" : file.status === "deleted" && file.hunks.length === 0 ? "deleted" : undefined)
    if (!reason) review.push(file)
    else if (byPath && byPath !== "binary" && file.status === "added" && isCodePath(file.path))
      hidden.push({ path: file.path, reason, additions: file.additions })
    else rest.push({ path: file.path, reason })
  }
  hidden.sort((a, b) => (b.additions ?? 0) - (a.additions ?? 0))
  return { review, skipped: [...hidden, ...rest] }
}

// Whether a generated header lets a file be skipped. For an existing file the base must agree, through its own
// header or a `linguist-generated` mark, so a pull request cannot hide a real change by adding a header. A file that
// has a header but is reviewed anyway comes back with `reviewedAnyway`; the summary then says so with
// noteGeneratedHeader from format.ts, which escapes the path.
export function generatedHeaderDecision(input: {
  path: string
  headText: string
  baseText?: string // the base version; undefined when the pull request adds the file
  attributes?: GitAttributes
  ignoreDefaults?: boolean
}): { skip: boolean; reviewedAnyway?: boolean } {
  if (input.ignoreDefaults === false || !hasGeneratedHeader(input.headText)) return { skip: false }
  const skip =
    input.baseText === undefined
      ? GENERATED_NAMES.some((glob) => minimatch(input.path, glob, { dot: true }))
      : hasGeneratedHeader(input.baseText) || !!input.attributes?.generated(input.path)
  return skip ? { skip: true } : { skip: false, reviewedAnyway: true }
}
