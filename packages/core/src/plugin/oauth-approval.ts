import path from "node:path"
import os from "node:os"
import { createHash, randomUUID } from "node:crypto"
import {
  constants,
  openSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { fileURLToPath } from "node:url"
import { xdgData } from "xdg-basedir"

export type OAuthDeclaration = { provider: string; clientId: string; issuer: string; apiOrigins: string[] }
export type OAuthApproval = {
  id: string
  plugin: string
  version: string
  root: string
  entry: string
  digest: string
  declaration: OAuthDeclaration
}
const active = new Map<string, { approval: OAuthApproval; count: number }>()
export const warning =
  "This plugin executes trusted code and receives provider credentials. Approval is not a sandbox or provider endorsement. Approve only a client the plugin author owns and is authorized to use."
export function approvalFile() {
  return path.join(
    xdgData ?? path.join(os.homedir(), ".local", "share"),
    process.env.VECTOR_APP_NAMESPACE ?? "vector",
    "plugin-oauth-approvals.json",
  )
}
export function borrowedOAuthPlugin(value: string) {
  return /(?:^|[/:])[^/:@]+-(?:openai-codex|copilot)-auth(?:@[^/]*)?$/i.test(value)
}

/** Hash the resolved plugin package, including supporting files. Never execute its module to request consent. */
export function inspectOAuthPlugin(entrypoint: string, rootHint?: string) {
  const input = entrypoint.startsWith("file://") ? fileURLToPath(entrypoint) : entrypoint
  const entry = realpathSync(input)
  const root = realpathSync(rootHint ?? pluginPackageRoot(entry))
  if (!entry.startsWith(root + path.sep) || !lstatSync(entry).isFile())
    throw new Error("Choose a plugin entrypoint inside its package directory.")
  const manifestFile = path.join(root, "package.json")
  const manifestStat = existsSync(manifestFile) ? lstatSync(manifestFile) : undefined
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 65_536)
    throw new Error("OAuth plugins require a regular package.json smaller than 64 KiB.")
  const manifest: unknown = JSON.parse(readFileSync(manifestFile, "utf8"))
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("OAuth plugins must declare vectorOAuth in their own package.json.")
  const fields = manifest as Record<string, unknown>
  if (
    typeof fields.name !== "string" ||
    !fields.name ||
    typeof fields.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(fields.version)
  )
    throw new Error("OAuth plugins require a package name and exact version.")
  if (borrowedOAuthPlugin(fields.name) || borrowedOAuthPlugin(input))
    throw new Error("Known borrowed-client sign-in plugins remain blocked in Vector.")
  if (!Array.isArray(fields.vectorOAuth) || fields.vectorOAuth.length < 1 || fields.vectorOAuth.length > 16)
    throw new Error("Declare an explicit vectorOAuth array in the plugin package.json.")
  const declarations = fields.vectorOAuth.map(declaration)
  if (new Set(declarations.map((value) => value.provider)).size !== declarations.length)
    throw new Error("Declare only one OAuth registration per provider.")
  const digest = packageDigest(root)
  return declarations.map((value) => {
    const identity = {
      plugin: fields.name as string,
      version: fields.version as string,
      root,
      entry,
      digest,
      declaration: value,
    }
    return { id: createHash("sha256").update(JSON.stringify(identity)).digest("hex"), ...identity }
  })
}
const loadedContent = new Map<string, string>()
/** Module imports are cached by the runtime. Changed content requires a process restart. */
export function inspectOAuthPluginForLoad(entry: string, root?: string) {
  const approvals = (() => {
    try {
      return inspectOAuthPlugin(entry, root)
    } catch {
      return []
    }
  })()
  const identity = approvals.map((value) => value.id).join(":")
  const canonical = realpathSync(entry.startsWith("file://") ? fileURLToPath(entry) : entry)
  const previous = loadedContent.get(canonical)
  if (previous !== undefined && previous !== identity && approvals.length)
    throw new Error("Plugin content changed after loading. Restart Vector before approving or using it.")
  loadedContent.set(canonical, identity)
  return approvals
}
export function confirmOAuthPluginLoad(approvals: OAuthApproval[]) {
  if (!approvals.length) return []
  const current = inspectOAuthPlugin(approvals[0].entry, approvals[0].root)
  if (approvals.map((value) => value.id).join(":") !== current.map((value) => value.id).join(":"))
    throw new Error("Plugin content changed while loading. Restart Vector and inspect it again.")
  return approvals.filter(approvalValid)
}
export function readOAuthApprovals(): OAuthApproval[] {
  try {
    const file = approvalFile()
    const value: unknown = JSON.parse(readApprovalText(file))
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("approvals" in value) ||
      !Array.isArray(value.approvals)
    )
      return []
    return value.approvals.filter((item): item is OAuthApproval => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.id !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.id) ||
        typeof item.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.digest) ||
        typeof item.root !== "string" ||
        typeof item.entry !== "string" ||
        typeof item.plugin !== "string" ||
        typeof item.version !== "string"
      )
        return false
      const { id, ...identity } = item
      return (
        !borrowedOAuthPlugin(item.plugin) &&
        declaration(item.declaration) &&
        id === createHash("sha256").update(JSON.stringify(identity)).digest("hex")
      )
    })
  } catch {
    return []
  }
}
export function writeOAuthApproval(approval: OAuthApproval) {
  const inspected = inspectOAuthPlugin(approval.entry, approval.root).find((value) => value.id === approval.id)
  if (!inspected) throw new Error("Plugin content changed while requesting approval. Inspect it again.")
  save([
    ...readOAuthApprovals().filter(
      (value) => !(value.root === approval.root && value.declaration.provider === approval.declaration.provider),
    ),
    inspected,
  ])
}
export function revokeOAuthApproval(id: string) {
  save(readOAuthApprovals().filter((value) => value.id !== id))
}
export function approvalValid(value: OAuthApproval) {
  return readOAuthApprovals().some((item) => item.id === value.id)
}
export function activateOAuthApproval(value: OAuthApproval) {
  if (!approvalValid(value)) return () => {}
  const entry = active.get(value.id)
  active.set(value.id, { approval: value, count: (entry?.count ?? 0) + 1 })
  return () => {
    const entry = active.get(value.id)
    if (!entry) return
    if (entry.count <= 1) active.delete(value.id)
    if (entry.count > 1) entry.count--
  }
}
export function activeOAuthApproval(provider: string, id?: string) {
  return [...active.values()]
    .map((value) => value.approval)
    .find((value) => value.declaration.provider === provider && (!id || value.id === id) && approvalValid(value))
}
export function pluginCredentialAllowed(
  provider: string,
  credential: { type?: string; metadata?: Readonly<Record<string, unknown>> },
  expectedID?: string,
) {
  const id = credential.metadata?.vector_plugin_oauth
  if (typeof id !== "string" || (expectedID !== undefined && id !== expectedID)) return false
  const approval = activeOAuthApproval(provider, id)
  return Boolean(
    approval &&
      credential.metadata?.oauth_client_id === approval.declaration.clientId &&
      credential.metadata?.oauth_instance_url === approval.declaration.issuer,
  )
}
export function pluginCredentialMetadata(approval: OAuthApproval) {
  if (!approvalValid(approval))
    throw new Error("Plugin OAuth approval was revoked. Approve this exact plugin version again before signing in.")
  return {
    vector_plugin_oauth: approval.id,
    oauth_client_id: approval.declaration.clientId,
    oauth_instance_url: approval.declaration.issuer,
  }
}
export function requirePluginAuthorization(approval: OAuthApproval, authorization: { url: string }) {
  pluginCredentialMetadata(approval)
  const url = URL.parse(authorization.url)
  if (
    !url ||
    url.origin !== approval.declaration.issuer ||
    url.username ||
    url.password ||
    url.searchParams.getAll("client_id").length > 1 ||
    (url.searchParams.has("client_id") && url.searchParams.get("client_id") !== approval.declaration.clientId)
  )
    throw new Error("Plugin authorization does not match its approved issuer and client.")
}
export function requirePluginDestination(approval: OAuthApproval, value: unknown) {
  pluginCredentialMetadata(approval)
  if (value === undefined || value === "") return
  const url = typeof value === "string" ? URL.parse(value) : null
  if (!url || !approval.declaration.apiOrigins.includes(url.origin) || url.username || url.password)
    throw new Error("Plugin OAuth cannot use an unapproved API origin.")
}
function declaration(input: unknown): OAuthDeclaration {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid plugin OAuth declaration.")
  const value = input as Record<string, unknown>
  if (
    typeof value.provider !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(value.provider) ||
    typeof value.clientId !== "string" ||
    !/^[A-Za-z0-9._-]{8,256}$/.test(value.clientId) ||
    typeof value.issuer !== "string" ||
    !Array.isArray(value.apiOrigins) ||
    !value.apiOrigins.length ||
    value.apiOrigins.length > 8
  )
    throw new Error("Declare provider, owned clientId, issuer and apiOrigins for plugin OAuth.")
  const origin = (input: unknown) => {
    const url = typeof input === "string" ? URL.parse(input) : null
    if (!url || url.protocol !== "https:" || url.origin !== input)
      throw new Error("Plugin OAuth origins must be exact HTTPS origins without paths or credentials.")
    return url.origin
  }
  return {
    provider: value.provider,
    clientId: value.clientId,
    issuer: origin(value.issuer),
    apiOrigins: value.apiOrigins.map(origin),
  }
}
export function pluginPackageRoot(entry: string) {
  let directory = path.dirname(entry.startsWith("file://") ? fileURLToPath(entry) : entry)
  while (true) {
    const file = path.join(directory, "package.json")
    if (existsSync(file)) {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new Error("Invalid plugin manifest.")
      const value = JSON.parse(readFileSync(file, "utf8"))
      if (typeof value.name === "string" && typeof value.version === "string") return directory
    }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error("OAuth plugins require their own package.json.")
    directory = parent
  }
}
export function blockedPluginEntry(entry: string) {
  try {
    return borrowedOAuthPlugin(
      JSON.parse(readFileSync(path.join(pluginPackageRoot(entry), "package.json"), "utf8")).name,
    )
  } catch {
    return false
  }
}

function packageDigest(root: string) {
  const hash = createHash("sha256")
  let count = 0
  let size = 0
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (["node_modules", ".git"].includes(name)) continue
      const file = path.join(directory, name)
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error("OAuth plugin content must not contain symlinks.")
      if (stat.isDirectory()) {
        visit(file)
        continue
      }
      if (!stat.isFile()) throw new Error("OAuth plugin content must contain only regular files.")
      count++
      size += stat.size
      if (count > 4096 || size > 64 * 1024 * 1024)
        throw new Error("Use a dedicated plugin package smaller than 64 MiB and 4096 files for OAuth approval.")
      hash.update(path.relative(root, file)).update("\0").update(readFileSync(file)).update("\0")
    }
  }
  visit(root)
  return hash.digest("hex")
}
function save(approvals: OAuthApproval[]) {
  const file = approvalFile()
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()))
    throw new Error("Refusing to replace a non-regular OAuth approval file.")
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify({ version: 1, approvals }, null, 2) + "\n", { mode: 0o600, flag: "wx" })
  renameSync(temporary, file)
}

function readApprovalText(file: string) {
  // O_NOFOLLOW is not enforced by every Windows runtime. Check the directory
  // entry and its identity around open so a symlink cannot borrow its target's approvals.
  const before = lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("OAuth approvals require a private, user-owned regular file.")
  }
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(descriptor)
    const after = lstatSync(file)
    if (
      !stat.isFile() ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== stat.dev ||
      before.ino !== stat.ino ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      stat.nlink !== 1 ||
      stat.size > 65_536 ||
      (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new Error("OAuth approvals require a private, user-owned regular file.")
    return readFileSync(descriptor, "utf8")
  } finally {
    closeSync(descriptor)
  }
}
