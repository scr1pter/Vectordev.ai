export * as LocalStartup from "./startup"

import { existsSync, readdirSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import { xdgConfig, xdgState } from "xdg-basedir"
import { ConfigLocalV1 } from "../v1/config/local"
import { LocalPolicy } from "./policy"

// Whether Vector Local may be on before config resolves its policy. The backstop asks at the first import of every
// entry point, synchronously, so that Egress starts pending (only this computer reachable) rather than off whenever a
// source Vector Local is read from turns it on, and nothing connects before config resolves it. It reads the sources
// the engine's Config.refreshLocal reads and trusts none of them: here a source can only hold connections until config
// resolves the policy, never let one through, so a file a standard user could have written counts, and so does a
// block Vector cannot decode, which config keeps on too. Config decides which of them apply. The Windows policy key
// is not read here, since reading it runs a program; config reads it as it loads.

const MANAGED_FILES = ["vector.json", "vector.jsonc"]
const GLOBAL_FILES = ["config.json", "vector.json", "vector.jsonc"]
const DIRECTORY_FILES = ["vector.json", "vector.jsonc", "vector.local.json", "vector.local.jsonc"]
const PROFILE = "ai.vector.managed.plist"
const PREFERENCES = "/Library/Managed Preferences"
// The user's block the owner last let apply, which config keeps in effect over a later edit that would loosen it.
const CONFIRMED = /^local-confirmed-[0-9a-f]+\.json$/
const Confirmed = Schema.Struct({ local: Schema.NullOr(ConfigLocalV1.Info) })

export type Input = {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform
  /** The managed folders: the system's own unless a test names others. */
  readonly managed?: readonly string[]
  /** The folder of the macOS MDM profiles. */
  readonly preferences?: string
  /** Vector's global config folder and its state folder: the user's own unless a test names others. */
  readonly config?: string
  readonly state?: string
}

/** Whether the environment, company policy or the user's own config may turn Vector Local on. */
export function enabled(input: Input = {}) {
  const env = input.env ?? process.env
  if (LocalPolicy.resolve({ env }).enabled) return true
  const platform = input.platform ?? process.platform
  const app = env.VECTOR_APP_NAMESPACE ?? "vector"
  const config = input.config ?? (xdgConfig ? path.join(xdgConfig, app) : undefined)
  const state = input.state ?? (xdgState ? path.join(xdgState, app) : undefined)
  const files = [
    ...(input.managed ?? managedDirectories(platform, env)).flatMap((folder) =>
      MANAGED_FILES.map((file) => path.join(folder, file)),
    ),
    ...(config ? GLOBAL_FILES.map((file) => path.join(config, file)) : []),
    // The desktop's own config folder, or one that may only tighten Vector Local: either can turn it on.
    ...(env.VECTOR_AGENT_CONFIG_DIR
      ? DIRECTORY_FILES.map((file) => path.join(path.resolve(env.VECTOR_AGENT_CONFIG_DIR!), file))
      : []),
    ...(env.VECTOR_AGENT_CONFIG ? [path.resolve(env.VECTOR_AGENT_CONFIG)] : []),
  ]
  return (
    files.some((file) => turnsOn(text(file))) ||
    turnsOn(env.VECTOR_CONFIG_CONTENT) ||
    confirmed(state) ||
    (platform === "darwin" && profile(input.preferences ?? PREFERENCES))
  )
}

// The system's managed folders, as config reads them: on Windows also the one the ProgramData variable names, which
// can only add a file to read here.
function managedDirectories(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>) {
  if (platform === "darwin") return ["/Library/Application Support/vector"]
  if (platform !== "win32") return ["/etc/vector"]
  const named = env.ProgramData?.trim()
  return [path.win32.join("C:\\ProgramData", "vector"), ...(named ? [path.win32.join(named, "vector")] : [])]
}

// Whether one config text's local block turns Vector Local on (a company's `lock` forces it on), or is one Vector
// cannot decode. A text that is not JSON with comments counts when it names a local block at all: config reads such a
// text leniently. (No JSONC library here: this runs first in every entry point, bundles included.)
function turnsOn(input: string | undefined) {
  if (!input || !/^\s*[{/]/.test(input)) return false
  return Option.match(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(plain(input)), {
    onNone: () => input.includes('"local"'),
    onSome: (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || !("local" in value)) return false
      if (value.local === undefined) return false
      return Option.match(Schema.decodeUnknownOption(ConfigLocalV1.Info)(value.local), {
        onNone: () => true,
        onSome: (block) => block.enabled === true || block.lock === true,
      })
    },
  })
}

// JSON with comments and trailing commas, as Vector's config files may be written, as plain JSON: strings are kept as
// they are, comments and a comma before a closing bracket are dropped.
function plain(input: string) {
  return input
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, string?: string) => string ?? "")
    .replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (_match, string?: string, close?: string) => string ?? close ?? "")
}

function confirmed(state: string | undefined) {
  if (!state || !existsSync(state)) return false
  return (readable(() => readdirSync(state)) ?? [])
    .filter((name) => CONFIRMED.test(name))
    .some((name) =>
      Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(Confirmed))(text(path.join(state, name)) ?? ""), {
        onNone: () => false,
        onSome: (saved) => saved.local?.enabled === true,
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

// A file or folder Vector cannot read says nothing here; config reports it.
function readable<T>(read: () => T) {
  try {
    return read()
  } catch {
    return undefined
  }
}
