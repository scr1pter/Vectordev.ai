export * as LocalStartup from "./startup"

import { existsSync, readdirSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import { xdgConfig, xdgState } from "xdg-basedir"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { ConfigManaged } from "../config/managed"
import { ConfigLocalV1 } from "../v1/config/local"
import { LocalPolicy } from "./policy"

// Whether Vector Local may be on before config resolves its policy. The backstop asks at the first import of every
// entry point, synchronously, so that Egress starts pending (only this computer reachable) rather than off whenever a
// source Vector Local is read from turns it on, and nothing connects before config resolves it. It reads the sources
// the engine's Config.refreshLocal reads and trusts none of them: here a source can only hold connections until config
// resolves the policy, never let one through, so a file a standard user could have written counts, and so do a block
// Vector cannot decode and a company policy file it cannot read, which config keeps on too. Config decides which of
// them apply. The Windows policy key
// is not read here, since reading it runs a program; config reads it as it loads. A process whose config never
// resolves the policy (the desktop's main process) resolves it from the same sources with `policy` instead, and reads
// company policy there as config does (ConfigManaged): only what an administrator alone could have written.

const MANAGED_FILES = ["vector.json", "vector.jsonc"]
const GLOBAL_FILES = ["config.json", "vector.json", "vector.jsonc"]
const DIRECTORY_FILES = ["vector.json", "vector.jsonc", "vector.local.json", "vector.local.jsonc"]
const PROFILE = "ai.vector.managed.plist"
const PREFERENCES = "/Library/Managed Preferences"
// The user's block the owner last let apply, which config keeps in effect over a later edit that would loosen it.
const CONFIRMED = /^local-confirmed-[0-9a-f]+\.json$/
const Confirmed = Schema.Struct({ local: Schema.NullOr(ConfigLocalV1.Info) })
// A user block Vector cannot decode keeps Vector Local on with no web until it is fixed, as config does.
const FAIL_CLOSED: ConfigLocalV1.Info = { enabled: true, web: "none" }

export type Input = {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform
  /**
   * The managed folders: the system's own, with the macOS profile and the Windows policy key, unless a test names
   * others (whose files alone are then read).
   */
  readonly managed?: readonly string[]
  /**
   * How the files in the managed folders a test names are checked (ConfigManaged.check). A test cannot create files
   * only root or Administrators own, so `user` lets the user running it own them; no one else may write them still.
   */
  readonly trust?: ConfigManaged.TrustOptions
  /** The folder of the macOS MDM profiles. */
  readonly preferences?: string
  /**
   * Vector's global config folder and its state folder: the user's own unless a test names others, or the desktop's
   * main process names the desktop's engine's.
   */
  readonly config?: string
  readonly state?: string
}

/** Whether the environment, company policy or the user's own config may turn Vector Local on. */
export function enabled(input: Input = {}) {
  const env = input.env ?? process.env
  if (LocalPolicy.resolve({ env }).enabled) return true
  const platform = input.platform ?? process.platform
  const files = locations(input)
  return (
    files.managed.some((file) => turnsOn(managedBlock(file))) ||
    [...files.user, ...files.overrides].some((file) => turnsOn(block(text(file)))) ||
    turnsOn(block(env.VECTOR_CONFIG_CONTENT)) ||
    confirmed(files.state).some(turnsOn) ||
    (platform === "darwin" && profile(input.preferences ?? PREFERENCES))
  )
}

/**
 * Vector Local's policy from the same sources, for a process whose config never resolves it: the desktop's main
 * process. Company policy and the user's own config (the global folder `config`, and the desktop's folder when
 * VECTOR_CLIENT is desktop) and the environment resolve it as the engine resolves them (LocalPolicy.resolve). Company
 * policy is read as the engine's config reads it: a file a standard user could have written is left out, with the
 * warning the engine gives, and one Vector cannot read or check, like a block it cannot decode, turns Vector Local on
 * with Web access None. The overrides and the block the owner last let apply can only turn it on and make Web access
 * stricter, never let more through.
 */
export function policy(input: Input = {}): LocalMode.Policy {
  const env = input.env ?? process.env
  const files = locations(input)
  const users = files.user.map((file) => block(text(file)))
  const company = companyPolicy(input)
  const blocks = company.blocks.map((item) => item.found)
  const resolved = LocalPolicy.resolve({
    env,
    managed: blocks.includes("undecodable")
      ? FAIL_CLOSED
      : blocks.filter(decoded).reduce<ConfigLocalV1.Info | undefined>(merge, undefined),
    global: users.includes("undecodable")
      ? FAIL_CLOSED
      : users.filter(decoded).reduce<ConfigLocalV1.Info | undefined>(merge, undefined),
  })
  const warned = { ...resolved, warnings: [...new Set([...resolved.warnings, ...company.warnings])] }
  const floors = [
    ...files.overrides.map((file) => block(text(file))),
    block(env.VECTOR_CONFIG_CONTENT),
    ...confirmed(files.state),
  ].filter(turnsOn)
  if (floors.length === 0) return warned
  return {
    ...warned,
    enabled: true,
    web: floors.reduce<LocalMode.Web>(
      (web, floor) => LocalPolicy.stricter(web, floor === "undecodable" ? "none" : floor.web),
      warned.web,
    ),
  }
}

/**
 * Whether company policy is on this computer: a managed file only an administrator could have written (readable or
 * not), the macOS profile or the Windows policy key. A file a standard user could have written is not one.
 */
export function managed(input: Input = {}) {
  return companyPolicy(input).blocks.length > 0
}

/**
 * The certificate files `local.ca.files` names, for the desktop's main process and its engine to add to the system and
 * default certificates: company policy's, then the user's own config's unless the company locks Vector Local. Company
 * policy counts only where an administrator alone could have written it, as the engine's config reads it, so a file a
 * standard user planted in a managed folder neither adds a certificate nor drops the user's own. A relative path is
 * read from the folder of the file that names it (the managed folder for the macOS profile and the Windows policy
 * key). The overrides and the environment name none, since a certificate trusts more rather than less.
 */
export function ca(input: Input = {}) {
  const files = locations(input)
  const named = (folder: string | undefined, found: ConfigLocalV1.Info | "undecodable" | undefined) =>
    decoded(found)
      ? (found.ca?.files ?? []).flatMap((item) =>
          path.isAbsolute(item) ? [item] : folder ? [path.resolve(folder, item)] : [],
        )
      : []
  const company = companyPolicy(input).blocks
  const lock = company.some((item) => decoded(item.found) && item.found.lock === true)
  const user = lock ? [] : files.user.map((file) => ({ folder: path.dirname(file), found: block(text(file)) }))
  return [...new Set([...company, ...user].flatMap((item) => named(item.folder, item.found)))]
}

// Company policy as the engine's config reads it (ConfigManaged.read): the managed files only an administrator could
// have written, then the macOS profile and the Windows policy key. A file a standard user could have written is left
// out; one Vector cannot read, or cannot check, may hold company policy and counts as a block it cannot decode. With
// managed folders a test names, their files alone, checked as `trust` says.
function companyPolicy(input: Input) {
  const read = input.managed
    ? {
        ...inspect(
          input.managed.flatMap((folder) => MANAGED_FILES.map((file) => path.join(folder, file))),
          input.trust ?? {},
        ),
        policies: [],
      }
    : ConfigManaged.read()
  const folder = (input.managed ?? ConfigManaged.directories())[0]
  return {
    blocks: [
      ...read.files.map((file) => ({ folder: path.dirname(file), found: managedBlock(file) })),
      ...read.policies.map((item) => ({ folder, found: block(item.text) })),
      ...read.ignored
        .filter((item) => item.kind === "unreadable")
        .map(() => ({ folder, found: "undecodable" as const })),
    ],
    warnings: read.ignored.map((item) =>
      item.kind === "untrusted" ? `${ConfigManaged.UNTRUSTED} ${item.reason}` : item.reason,
    ),
  }
}

// The managed files a test names that exist, checked as ConfigManaged.read checks the system's.
function inspect(candidates: readonly string[], trust: ConfigManaged.TrustOptions) {
  const checked = candidates
    .filter((file) => existsSync(file))
    .map((file) => ({ file, verdict: ConfigManaged.check(file, trust) }))
  return {
    files: checked.filter((item) => item.verdict === undefined).map((item) => item.file),
    ignored: checked.flatMap((item) => (item.verdict ? [{ source: item.file, ...item.verdict }] : [])),
  }
}

// The files each source is read from: the managed folders, the user's own config, and the overrides that may only
// tighten it, with the state folder that keeps the block the owner last let apply.
function locations(input: Input) {
  const env = input.env ?? process.env
  const app = env.VECTOR_APP_NAMESPACE ?? "vector"
  const config = input.config ?? (xdgConfig ? path.join(xdgConfig, app) : undefined)
  // The desktop's own config folder (it names itself with VECTOR_CLIENT=desktop) is the user's; any other
  // VECTOR_AGENT_CONFIG_DIR may only tighten Vector Local. Either can turn it on.
  const directory = env.VECTOR_AGENT_CONFIG_DIR
    ? DIRECTORY_FILES.map((file) => path.join(path.resolve(env.VECTOR_AGENT_CONFIG_DIR!), file))
    : []
  const desktop = env.VECTOR_CLIENT === "desktop"
  return {
    managed: (input.managed ?? ConfigManaged.systemDirectories(input.platform ?? process.platform, env)).flatMap(
      (folder) => MANAGED_FILES.map((file) => path.join(folder, file)),
    ),
    user: [...(config ? GLOBAL_FILES.map((file) => path.join(config, file)) : []), ...(desktop ? directory : [])],
    overrides: [
      ...(desktop ? [] : directory),
      ...(env.VECTOR_AGENT_CONFIG ? [path.resolve(env.VECTOR_AGENT_CONFIG)] : []),
    ],
    state: input.state ?? (xdgState ? path.join(xdgState, app) : undefined),
  }
}

// One config text's local block: undefined when it has none, and "undecodable" for one Vector cannot decode or a text
// that is not JSON with comments but names a local block at all, since config reads such a text leniently. (No JSONC
// library here: this runs first in every entry point, bundles included.)
function block(input: string | undefined): ConfigLocalV1.Info | "undecodable" | undefined {
  if (!input || !/^\s*[{/]/.test(input)) return undefined
  return Option.match(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(plain(input)), {
    onNone: () => (input.includes('"local"') ? "undecodable" : undefined),
    onSome: (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || !("local" in value)) return undefined
      if (value.local === undefined) return undefined
      return Option.getOrElse(
        Schema.decodeUnknownOption(ConfigLocalV1.Info)(value.local),
        (): ConfigLocalV1.Info | "undecodable" => "undecodable",
      )
    },
  })
}

// Whether a block turns Vector Local on: a company's `lock` forces it on, and a block Vector cannot decode keeps it on.
function turnsOn(found: ConfigLocalV1.Info | "undecodable" | undefined): found is ConfigLocalV1.Info | "undecodable" {
  return found === "undecodable" || found?.enabled === true || found?.lock === true
}

function decoded(found: ConfigLocalV1.Info | "undecodable" | undefined): found is ConfigLocalV1.Info {
  return found !== undefined && found !== "undecodable"
}

// Blocks merged in the order config merges their files, as config merges them (remeda's mergeDeep): a later file's
// keys win, objects merge key by key, and a later list replaces an earlier one.
function merge(merged: ConfigLocalV1.Info | undefined, next: ConfigLocalV1.Info): ConfigLocalV1.Info {
  if (!merged) return next
  return deepMerge(merged, next) as ConfigLocalV1.Info
}

function deepMerge(left: unknown, right: unknown): unknown {
  if (!isObject(left) || !isObject(right)) return right
  return Object.fromEntries(
    [...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => [
      key,
      key in right ? deepMerge(left[key], right[key]) : left[key],
    ]),
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// JSON with comments and trailing commas, as Vector's config files may be written, as plain JSON: strings are kept as
// they are, comments and a comma before a closing bracket are dropped.
function plain(input: string) {
  return input
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, string?: string) => string ?? "")
    .replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (_match, string?: string, close?: string) => string ?? close ?? "")
}

// The blocks the owner last let apply, kept in the state folder.
function confirmed(state: string | undefined) {
  if (!state || !existsSync(state)) return []
  return (readable(() => readdirSync(state)) ?? [])
    .filter((name) => CONFIRMED.test(name))
    .flatMap((name) =>
      Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(Confirmed))(text(path.join(state, name)) ?? ""), {
        onNone: () => [],
        onSome: (saved) => (saved.local ? [saved.local] : []),
      }),
    )
}

// An MDM profile, the user's own or the computer's. It is a binary plist, and converting it runs a program, so a
// profile that has a `local` key at all counts.
function profile(root: string) {
  const user = readable(() => os.userInfo().username) || "user"
  return [path.join(root, user, PROFILE), path.join(root, PROFILE)].some(
    (file) => existsSync(file) && readable(() => readFileSync(file))?.includes("local") === true,
  )
}

function text(file: string) {
  if (!existsSync(file)) return undefined
  return readable(() => readFileSync(file, "utf8"))
}

// A company policy file's local block. One that is there but that Vector cannot read (no permission, a folder in its
// place) might say anything, so it counts as a block Vector cannot decode, as config counts it.
function managedBlock(file: string) {
  if (!existsSync(file)) return undefined
  const content = text(file)
  return content === undefined ? "undecodable" : block(content)
}

// A file or folder Vector cannot read says nothing here, but for a company policy file (managedBlock); config reports
// it.
function readable<T>(read: () => T) {
  try {
    return read()
  } catch {
    return undefined
  }
}
