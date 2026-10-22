export * as ConfigManaged from "./managed"

import { spawnSync } from "child_process"
import { existsSync, realpathSync, statSync } from "fs"
import os from "os"
import path from "path"
import { Option, Schema } from "effect"

// Company policy: the managed folder's vector.json and vector.jsonc, the macOS MDM profile and, on Windows, the
// policy key. It overrides the user's own config, so it counts only when an administrator is the only one who could
// have written it. Everything here is synchronous: Vector Local resolves its policy from these sources once, at
// process start, before any startup fetch, and the config loader reads the same sources so the two always agree.

const MANAGED_PLIST_DOMAINS = ["ai.vector.managed"]

// Keys injected by macOS/MDM into the managed plist that are not Vector config
const PLIST_META = new Set([
  "PayloadDisplayName",
  "PayloadIdentifier",
  "PayloadType",
  "PayloadUUID",
  "PayloadVersion",
  "_manualProfile",
])

/** The Windows policy key. Only administrators can write under HKLM\SOFTWARE\Policies; it holds vector.json as text. */
export const REGISTRY_KEY = "HKLM\\SOFTWARE\\Policies\\Vector"
export const REGISTRY_VALUE = "Config"

/** What the Vector Local pane shows for a policy file it ignored. */
export const UNTRUSTED = "Ignored a policy file that standard users can change."

const MANAGED_FILES = ["vector.json", "vector.jsonc"]

// Windows accounts that only administrators control. CREATOR OWNER and OWNER RIGHTS stand for the owner, which must
// be one of these anyway.
const SYSTEM = "S-1-5-18"
const ADMINISTRATORS = "S-1-5-32-544"
const TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
const OWNER_STAND_INS = ["S-1-3-0", "S-1-3-4"]

// Rights that let someone change a file's contents, replace it or take it over: write and append data, delete, change
// permissions, take ownership, and the generic all and write rights.
const FILE_WRITE = 0x2 | 0x4 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000
// Rights over a folder that let someone remove or replace the files an administrator put there: delete child, delete,
// change permissions, take ownership and generic all. Creating new files is not among them: C:\ProgramData lets every
// user create files by default, and a file a user creates is theirs, which the file check refuses.
const FOLDER_WRITE = 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x10000000

export type Policy = { readonly source: string; readonly text: string }
export type Ignored = { readonly source: string; readonly reason: string }

export type Read = {
  /** Managed config files that passed the trust check, in merge order. */
  readonly files: readonly string[]
  /** The MDM profile or the Windows policy key, merged after the files. */
  readonly policies: readonly Policy[]
  /** Sources that exist but were ignored, and why. */
  readonly ignored: readonly Ignored[]
}

export type AclRule = {
  readonly sid: string
  readonly rights: number
  readonly allow: boolean
  /** An inherit-only entry applies to what is created inside a folder, not to the folder itself. */
  readonly inheritOnly?: boolean
}
export type Acl = { readonly owner: string; readonly rules: readonly AclRule[] }
/** Reads the owner and access rules of each path, and the SID of the user running Vector. */
export type AclReader = (paths: readonly string[]) => {
  readonly user?: string
  readonly entries: Readonly<Record<string, Acl | undefined>>
}

export type TrustOptions = {
  readonly platform?: NodeJS.Platform
  /** Reads Windows access rules. The default asks PowerShell. */
  readonly acl?: AclReader
  /**
   * Whether the user running Vector may own the file too. Only the test managed folder allows it, since a test cannot
   * create files owned by root or Administrators. The rest of the check (no one else may write) still applies.
   */
  readonly user?: boolean
}

export function managedConfigDir() {
  const override = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR
  if (override) return override
  return systemManagedConfigDir()
}

/**
 * Every managed source, with the ones a standard user could have written left out. A missing source is not listed.
 * The managed folder is the test folder when VECTOR_TEST_MANAGED_CONFIG_DIR is set, and then this computer's own MDM
 * profile and policy key are left out too, so a test never reads the machine's real company policy.
 */
export function read(): Read {
  const directory = managedConfigDir()
  const test = Boolean(process.env.VECTOR_TEST_MANAGED_CONFIG_DIR)
  const files = MANAGED_FILES.map((file) => path.join(directory, file)).filter((file) => existsSync(file))
  const checked = files.map((file) => ({ file, reason: untrusted(file, { user: test }) }))
  const plist = process.platform === "darwin" && !test ? readManagedPreferences() : undefined
  const registry = process.platform === "win32" && !test ? readRegistry() : undefined
  return {
    files: checked.filter((item) => item.reason === undefined).map((item) => item.file),
    policies: [plist, registry].flatMap((item) => (item && "text" in item ? [item] : [])),
    ignored: [
      ...checked.flatMap((item) => (item.reason ? [{ source: item.file, reason: item.reason }] : [])),
      ...[plist].flatMap((item) => (item && "reason" in item ? [item] : [])),
    ],
  }
}

/**
 * Why a managed file cannot be trusted, or undefined when only an administrator could have changed it (or it does not
 * exist). macOS and Linux: the file and every folder above it must be owned by root, and no one else may write them;
 * a group write by root's own group is allowed, as is a world-writable folder with the sticky bit (/tmp), whose
 * entries only their owners can replace. Windows: the folder and the file must be owned by Administrators, SYSTEM or
 * TrustedInstaller, and no other account may be granted the rights to change or replace them.
 */
export function untrusted(file: string, options: TrustOptions = {}): string | undefined {
  if (!existsSync(file)) return undefined
  if ((options.platform ?? process.platform) === "win32")
    return windowsUntrusted(file, options.acl ?? powershellAcl, options.user === true)
  return posixUntrusted(file, options.user === true)
}

/** Why a POSIX file or folder cannot be trusted, from its stat, or undefined when it can. */
export function posixReason(
  entry: { readonly path: string; readonly uid: number; readonly gid: number; readonly mode: number },
  owners: readonly number[],
) {
  if (!owners.includes(entry.uid)) return `${entry.path} is not owned by root.`
  const group = (entry.mode & 0o020) !== 0 && entry.gid !== 0
  const world = (entry.mode & 0o002) !== 0
  const sticky = (entry.mode & 0o170000) === 0o040000 && (entry.mode & 0o1000) !== 0
  if ((group || world) && !sticky) return `${entry.path} can be changed by other users.`
  return undefined
}

/** Why a Windows file or folder cannot be trusted, from its owner and access rules, or undefined when it can. */
export function windowsReason(target: string, acl: Acl, kind: "file" | "folder", owners: readonly string[]) {
  if (!owners.includes(acl.owner)) return `${target} is not owned by Administrators or SYSTEM.`
  const rights = kind === "file" ? FILE_WRITE : FOLDER_WRITE
  const grant = acl.rules.find(
    (rule) =>
      rule.allow &&
      !rule.inheritOnly &&
      !owners.includes(rule.sid) &&
      !OWNER_STAND_INS.includes(rule.sid) &&
      (rule.rights & rights) !== 0,
  )
  if (grant) return `${target} lets ${grant.sid} change it.`
  return undefined
}

/** The policy key's Config value from `reg query` output, or undefined when it holds none. */
export function parseRegistry(stdout: string) {
  const match = new RegExp(`^\\s+${REGISTRY_VALUE}\\s+REG_(?:EXPAND_)?SZ\\s+(.*?)\\s*$`, "m").exec(stdout)
  return match?.[1] || undefined
}

export function parseManagedPlist(json: string): string {
  const raw = JSON.parse(json)
  for (const key of Object.keys(raw)) {
    if (PLIST_META.has(key)) delete raw[key]
  }
  return JSON.stringify(raw)
}

function systemManagedConfigDir(name = "vector"): string {
  switch (process.platform) {
    case "darwin":
      return `/Library/Application Support/${name}`
    case "win32":
      return path.join(process.env.ProgramData || "C:\\ProgramData", name)
    default:
      return `/etc/${name}`
  }
}

function readManagedPreferences(): Policy | Ignored | undefined {
  const user = (() => {
    try {
      return os.userInfo().username || "user"
    } catch {
      return "user"
    }
  })()
  const plist = MANAGED_PLIST_DOMAINS.flatMap((domain) => [
    path.join("/Library/Managed Preferences", user, `${domain}.plist`),
    path.join("/Library/Managed Preferences", `${domain}.plist`),
  ]).find((file) => existsSync(file))
  if (!plist) return undefined
  const reason = untrusted(plist)
  if (reason) return { source: `mobileconfig:${plist}`, reason }
  const result = spawnSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8", timeout: 10_000 })
  if (result.status !== 0) return undefined
  return { source: `mobileconfig:${plist}`, text: parseManagedPlist(result.stdout) }
}

// `reg query` prints in the console's code page, so text outside ASCII belongs in \u escapes inside the JSON.
function readRegistry(): Policy | undefined {
  const result = spawnSync("reg", ["query", REGISTRY_KEY, "/v", REGISTRY_VALUE, "/reg:64"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  })
  if (result.status !== 0) return undefined
  const text = parseRegistry(result.stdout)
  if (!text) return undefined
  return { source: `registry:${REGISTRY_KEY}`, text }
}

function posixUntrusted(file: string, user: boolean) {
  const owners = user && process.getuid ? [0, process.getuid()] : [0]
  // The folder that holds the file and the file it resolves to, each with every folder above it: a link in the
  // managed folder could point anywhere, and a folder someone else can write lets them swap the file.
  const chain = [...new Set([...ancestors(realpathSync(file)), ...ancestors(realpathSync(path.dirname(file)))])]
  return chain
    .map((target) => {
      const stat = statSync(target)
      return posixReason({ path: target, uid: stat.uid, gid: stat.gid, mode: stat.mode }, owners)
    })
    .find((reason) => reason !== undefined)
}

function ancestors(target: string): string[] {
  const parent = path.dirname(target)
  if (parent === target) return [target]
  return [target, ...ancestors(parent)]
}

const aclCache = new Map<string, ReturnType<AclReader>>()

function windowsUntrusted(file: string, reader: AclReader, user: boolean) {
  const folder = path.dirname(file)
  const acl = cachedAcl(reader, [folder, file])
  const owners = [SYSTEM, ADMINISTRATORS, TRUSTED_INSTALLER, ...(user && acl.user ? [acl.user] : [])]
  return (
    [
      [folder, "folder"],
      [file, "file"],
    ] as const
  )
    .map(([target, kind]) => {
      const entry = acl.entries[target]
      if (!entry) return `Vector could not read who may change ${target}.`
      return windowsReason(target, entry, kind, owners)
    })
    .find((reason) => reason !== undefined)
}

// PowerShell takes a moment to start, so a verdict is kept until the folder or the file changes; changing an access
// rule updates a file's change time too.
function cachedAcl(reader: AclReader, paths: readonly string[]) {
  if (reader !== powershellAcl) return reader(paths)
  const key = paths
    .map((target) => {
      const stat = statSync(target)
      return `${target}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
    })
    .join("|")
  const cached = aclCache.get(key)
  if (cached) return cached
  const result = reader(paths)
  aclCache.set(key, result)
  return result
}

const PowershellAcl = Schema.Struct({
  user: Schema.optional(Schema.String),
  entries: Schema.Record(
    Schema.String,
    Schema.Struct({
      owner: Schema.String,
      rules: Schema.Array(
        Schema.Struct({
          sid: Schema.String,
          rights: Schema.Number,
          allow: Schema.Boolean,
          inheritOnly: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ),
})

// Owner and rules as SIDs, so the check does not depend on the language Windows names its accounts in.
const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sid = [System.Security.Principal.SecurityIdentifier]",
  "$out = @{ user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; entries = @{} }",
  "foreach ($p in ($env:VECTOR_ACL_PATHS | ConvertFrom-Json)) {",
  "  try {",
  "    $acl = Get-Acl -LiteralPath $p",
  "    $rules = @($acl.GetAccessRules($true, $true, $sid) | ForEach-Object {",
  "      @{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights;",
  "         allow = ($_.AccessControlType -eq 'Allow'); inheritOnly = (($_.PropagationFlags -band 2) -ne 0) } })",
  "    $out.entries[$p] = @{ owner = $acl.GetOwner($sid).Value; rules = $rules }",
  "  } catch {}",
  "}",
  "$out | ConvertTo-Json -Depth 6 -Compress",
].join("\n")

function powershellAcl(paths: readonly string[]): ReturnType<AclReader> {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ACL_SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, VECTOR_ACL_PATHS: JSON.stringify(paths) },
    timeout: 20_000,
    windowsHide: true,
  })
  if (result.status !== 0) return { entries: {} }
  return Option.getOrElse(
    Schema.decodeUnknownOption(Schema.fromJsonString(PowershellAcl))(result.stdout.trim()),
    () => ({ entries: {} }),
  )
}
