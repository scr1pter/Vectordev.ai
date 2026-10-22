export * as LocalStartup from "./startup"

import { existsSync, readdirSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import { xdgConfig, xdgState } from "xdg-basedir"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { ConfigLocalV1 } from "../v1/config/local"
import { LocalPolicy } from "./policy"

// Whether Vector Local may be on before config resolves its policy. The backstop asks at the first import of every
// entry point, synchronously, so that Egress starts pending (only this computer reachable) rather than off whenever a
// source Vector Local is read from turns it on, and nothing connects before config resolves it. It reads the sources
// the engine's Config.refreshLocal reads and trusts none of them: here a source can only hold connections until config
// resolves the policy, never let one through, so a file a standard user could have written counts, and so does a
// block Vector cannot decode, which config keeps on too. Config decides which of them apply. The Windows policy key
// is not read here, since reading it runs a program; config reads it as it loads. A process whose config never
// resolves the policy (the desktop's main process) resolves it from the same sources with `policy` instead.

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
  /** The managed folders: the system's own unless a test names others. */
  readonly managed?: readonly string[]
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
    [...files.managed, ...files.user, ...files.overrides].some((file) => turnsOn(block(text(file)))) ||
    turnsOn(block(env.VECTOR_CONFIG_CONTENT)) ||
    confirmed(files.state).some(turnsOn) ||
    (platform === "darwin" && profile(input.preferences ?? PREFERENCES))
  )
}

/**
 * Vector Local's policy from the same sources, for a process whose config never resolves it: the desktop's main
 * process, until it reads the company's policy the way the engine does. The user's own config (the global folder
 * `config`, and the desktop's folder when VECTOR_CLIENT is desktop) and the environment resolve it as the engine
 * resolves them. A company policy file, whose owner is not checked here, the overrides and the block the owner last let
 * apply can only turn it on and make Web access stricter, never let more through; a block Vector cannot decode turns
 * it on with Web access None, as config does. The macOS profile is not read, since converting it runs a program.
 */
export function policy(input: Input = {}): LocalMode.Policy {
  const env = input.env ?? process.env
  const files = locations(input)
  const users = files.user.map((file) => block(text(file)))
  const resolved = LocalPolicy.resolve({
    env,
    global: users.includes("undecodable")
      ? FAIL_CLOSED
      : users.filter(decoded).reduce<ConfigLocalV1.Info | undefined>(merge, undefined),
  })
  const floors = [
    ...[...files.managed, ...files.overrides].map((file) => block(text(file))),
    block(env.VECTOR_CONFIG_CONTENT),
    ...confirmed(files.state),
  ].filter(turnsOn)
  if (floors.length === 0) return resolved
  return {
    ...resolved,
    enabled: true,
    web: floors.reduce<LocalMode.Web>(
      (web, floor) => LocalPolicy.stricter(web, floor === "undecodable" ? "none" : floor.web),
      resolved.web,
    ),
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
    managed: (input.managed ?? managedDirectories(input.platform ?? process.platform, env)).flatMap((folder) =>
      MANAGED_FILES.map((file) => path.join(folder, file)),
    ),
    user: [...(config ? GLOBAL_FILES.map((file) => path.join(config, file)) : []), ...(desktop ? directory : [])],
    overrides: [
      ...(desktop ? [] : directory),
      ...(env.VECTOR_AGENT_CONFIG ? [path.resolve(env.VECTOR_AGENT_CONFIG)] : []),
    ],
    state: input.state ?? (xdgState ? path.join(xdgState, app) : undefined),
  }
}

// The system's managed folders, as config reads them: on Windows also the one the ProgramData variable names, which
// can only add a file to read here.
function managedDirectories(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>) {
  if (platform === "darwin") return ["/Library/Application Support/vector"]
  if (platform !== "win32") return ["/etc/vector"]
  const named = env.ProgramData?.trim()
  return [path.win32.join("C:\\ProgramData", "vector"), ...(named ? [path.win32.join(named, "vector")] : [])]
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

// The user's blocks merged in the order config merges their files: a later file's keys win, and web_domains merges.
function merge(merged: ConfigLocalV1.Info | undefined, next: ConfigLocalV1.Info): ConfigLocalV1.Info {
  if (!merged) return next
  const domains = merged.web_domains || next.web_domains ? { ...merged.web_domains, ...next.web_domains } : undefined
  return { ...merged, ...next, ...(domains ? { web_domains: domains } : {}) }
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

// A file or folder Vector cannot read says nothing here; config reports it.
function readable<T>(read: () => T) {
  try {
    return read()
  } catch {
    return undefined
  }
}
