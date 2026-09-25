export * as ConfigMigration from "./migration"

import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import TOML from "smol-toml"
import { FSUtil } from "../fs-util"
import { EffectFlock } from "../util/effect-flock"
import { ConfigV1 } from "../v1/config/config"

const excluded = /^(?:vector|tui|package|auth|credential|secret|license|desktop-theme)(?:[.-]|$)/i
const assetNames = [
  "agent",
  "agents",
  "command",
  "commands",
  "plugin",
  "plugins",
  "skill",
  "skills",
  "theme",
  "themes",
  "tool",
  "tools",
  "mode",
  "modes",
]
const ignoredDirectories = new Set([
  ".vector",
  ".git",
  ".claude",
  ".agents",
  ".codex",
  ".config",
  ".cache",
  ".local",
  ".npm",
  ".ssh",
  ".gnupg",
])
const configKeys = new Set(Object.keys(ConfigV1.Info.fields))
const decode = Schema.decodeUnknownOption(ConfigV1.Info)

export function parseConfig(text: string, file: string): unknown {
  if (file.endsWith(".toml") || !/^\s*[{/]/.test(text)) {
    const data = TOML.parse(text)
    if (typeof data.provider !== "string" || typeof data.model !== "string") return data
    return {
      ...Object.fromEntries(Object.entries(data).filter(([key]) => key !== "provider")),
      model: `${data.provider}/${data.model}`,
    }
  }
  const errors: ParseError[] = []
  const result: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) throw new Error(`Invalid settings in ${file}. Repair this file before starting Vector.`)
  return result
}

function decodeConfig(data: Record<string, unknown>) {
  if (Object.keys(data).some((key) => !configKeys.has(key))) throw new Error("Unknown configuration property")
  const decoded = decode(data)
  if (Option.isNone(decoded)) throw new Error("Invalid configuration shape")
  return decoded.value
}

function mergeSettings(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({ ...left, ...right }).map(([key, value]) => [
      key,
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      left[key] &&
      typeof left[key] === "object" &&
      !Array.isArray(left[key])
        ? mergeSettings(left[key] as Record<string, unknown>, value as Record<string, unknown>)
        : value,
    ]),
  )
}

export const run = Effect.fn("ConfigMigration.run")(function* (
  directory: string,
  local = false,
  destination = directory,
) {
  const fs = yield* FSUtil.Service
  if (!(yield* fs.isDir(directory))) return
  const flock = yield* EffectFlock.Service
  return yield* flock.withLock(
    Effect.gen(function* () {
      const stem = local ? "vector.local" : "vector"
      const targets = [path.join(destination, `${stem}.json`), path.join(destination, `${stem}.jsonc`)]
      for (const target of targets) {
        const text = yield* fs.readFileStringSafe(target)
        if (!text) continue
        const parsed = Option.liftThrowable(() => parseConfig(text, target))()
        // Existing Vector files belong to the normal loader, including its error handling.
        if (Option.isNone(parsed)) return
        if (
          parsed.value &&
          typeof parsed.value === "object" &&
          Object.keys(parsed.value).some((key) => key !== "$schema")
        )
          return
      }

      const entries = yield* fs.readDirectoryEntries(directory)
      const candidates = yield* Effect.forEach(
        entries.filter(
          (entry) =>
            entry.type === "file" &&
            !excluded.test(entry.name) &&
            (local
              ? /\.local\.jsonc?$/.test(entry.name)
              : (/\.(?:jsonc?|toml)$/.test(entry.name) || !entry.name.includes(".")) && !/\.local\./.test(entry.name)),
        ),
        Effect.fnUntraced(function* (entry) {
          const file = path.join(directory, entry.name)
          if ((yield* fs.stat(file)).size > 1_048_576n) return
          const text = yield* fs.readFileString(file)
          const parsed = yield* Effect.try({ try: () => parseConfig(text, file), catch: (error) => error }).pipe(
            Effect.option,
          )
          if (Option.isNone(parsed)) {
            if (
              /\$schema["']?\s*[:=]\s*["'][^"']*\/config\.json["']/.test(text) ||
              /["']?permission["']?\s*[:=]/.test(text)
            )
              return yield* Effect.die(
                new Error(`Cannot import settings from ${file}. Repair this file before starting Vector.`),
              )
            return
          }
          if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return
          const data = Object.fromEntries(
            Object.entries(parsed.value).filter(([key]) => !["theme", "keybinds", "tui"].includes(key)),
          )
          const decoded = yield* Effect.try({
            try: () => decodeConfig(data),
            catch: (error) => error,
          }).pipe(Effect.option)
          if (Option.isNone(decoded)) {
            if (
              (typeof data.$schema === "string" && /\/config\.json(?:[?#]|$)/.test(data.$schema)) ||
              "permission" in data
            ) {
              return yield* Effect.die(
                new Error(`Cannot import settings from ${file}. Correct this config before starting Vector.`),
              )
            }
            return
          }
          const tui = Object.fromEntries(
            Object.entries(parsed.value).filter(([key]) => ["theme", "keybinds", "tui"].includes(key)),
          )
          if (!Object.keys(decoded.value).some((key) => key !== "$schema") && !Object.keys(tui).length) return
          return {
            file,
            name: entry.name,
            text: /^\s*[{/]/.test(text) ? text : JSON.stringify(parsed.value, null, 2),
            data: { ...decoded.value, ...tui },
          }
        }),
      )
      const sources = candidates.filter((item) => item !== undefined)
      const families = new Set(
        sources
          .filter((item) => !["config", "config.json", "config.toml"].includes(item.name))
          .map((item) => item.name.replace(/\.(?:jsonc?|toml)$/, "")),
      )
      if (!sources.length) return
      if (families.size > 1) {
        return yield* Effect.die(
          new Error(
            `Multiple settings files found in ${directory}. Merge them into ${targets[1]} before starting Vector.`,
          ),
        )
      }
      const ordered = sources.toSorted(
        (a, b) =>
          Number(["config", "config.toml"].includes(a.name)) - Number(["config", "config.toml"].includes(b.name)) ||
          Number(a.name !== "config.json") - Number(b.name !== "config.json") ||
          Number(a.name.endsWith(".jsonc")) - Number(b.name.endsWith(".jsonc")),
      )
      const merged = ordered.reduce<Record<string, unknown>>((result, item) => mergeSettings(result, item.data), {})
      const original = ordered.at(-1)!.text
      const text = Object.entries({ ...merged, $schema: "https://vectordev.ai/config.json" }).reduce(
        (result, [key, value]) =>
          applyEdits(result, modify(result, [key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
        original,
      )
      if (local) {
        const gitignore = path.join(destination, ".gitignore")
        const existing = (yield* fs.readFileStringSafe(gitignore)) ?? ""
        const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()))
        const missing = targets.map((file) => path.basename(file)).filter((file) => !lines.has(file))
        if (missing.length) {
          yield* fs.writeFileString(gitignore, [existing.trimEnd(), ...missing].filter(Boolean).join("\n") + "\n")
        }
      }
      // Write beside the destination and rename atomically. Never change the source files.
      yield* fs.ensureDir(destination)
      const temporary = `${targets[1]}.${crypto.randomUUID()}.tmp`
      yield* fs.writeFileString(temporary, text, { mode: 0o600, flag: "wx" })
      yield* fs.rename(temporary, targets[1]).pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)))
      const message = `Imported settings from ${ordered.map((item) => item.file).join(", ")} into ${targets[1]}. Original files were kept.`
      yield* Effect.logInfo(message)
      return { sources: ordered.map((item) => item.file), target: targets[1], message }
    }),
    `config-import:${directory}:${local}`,
  )
})

/** Copy only recognized configuration assets. An unrelated hidden folder is never imported. */
export const discover = Effect.fn("ConfigMigration.discover")(function* (input: {
  directory: string
  worktree?: string
  global: string
  home: string
  disableProject?: boolean
}) {
  const fs = yield* FSUtil.Service
  const results: Array<{ sources: string[]; target: string; message: string }> = []
  const global = yield* run(input.global)
  if (global) results.push(global)
  const parents: string[] = []
  const visit = (directory: string): void => {
    parents.push(directory)
    const parent = path.dirname(directory)
    if (directory === input.worktree || directory === input.home || parent === directory) return
    visit(parent)
  }
  if (!input.disableProject) visit(path.resolve(input.directory))
  for (const directory of parents.toReversed()) {
    const imported = yield* run(directory)
    if (imported) results.push(imported)
  }
  for (const directory of new Set([input.home, ...parents])) {
    if (!(yield* fs.isDir(directory))) continue
    const entries = yield* fs.readDirectoryEntries(directory)
    const folders = yield* Effect.forEach(
      entries.filter(
        (entry) => entry.type === "directory" && entry.name.startsWith(".") && !ignoredDirectories.has(entry.name),
      ),
      Effect.fnUntraced(function* (entry) {
        const source = path.join(directory, entry.name)
        const files = yield* fs.readDirectoryEntries(source)
        const assets = files.filter((file) => file.type === "directory" && assetNames.includes(file.name))
        if (!assets.length) return
        const identified =
          assets.length > 1 ||
          (yield* Effect.forEach(
            files.filter(
              (file) => file.type === "file" && !excluded.test(file.name) && /\.(?:jsonc?|toml)$/.test(file.name),
            ),
            Effect.fnUntraced(function* (file) {
              const text = yield* fs.readFileString(path.join(source, file.name))
              const data = yield* Effect.try({ try: () => parseConfig(text, file.name), catch: () => undefined }).pipe(
                Effect.option,
              )
              if (Option.isNone(data) || !data.value || typeof data.value !== "object" || Array.isArray(data.value))
                return false
              const value = Object.fromEntries(
                Object.entries(data.value).filter(([key]) => !["theme", "keybinds", "tui"].includes(key)),
              )
              return (
                (typeof value.$schema === "string" && /\/config\.json(?:[?#]|$)/.test(value.$schema)) ||
                (Object.keys(value).some((key) => key !== "$schema") &&
                  Object.keys(value).every((key) => configKeys.has(key)) &&
                  Option.isSome(decode(value)))
              )
            }),
          )).some(Boolean)
        if (!identified) return
        return { source, files, assets }
      }),
    )
    const recognized = folders.filter((folder) => folder !== undefined)
    if (recognized.length > 1)
      return yield* Effect.die(
        new Error(
          `Multiple earlier agent folders found in ${directory}. Merge their settings into .vector before starting Vector.`,
        ),
      )
    const folder = recognized[0]
    if (!folder) continue
    const target = path.join(directory, ".vector")
    if (entries.find((entry) => entry.name === ".vector")?.type === "symlink")
      return yield* Effect.die(
        new Error(
          `Cannot import into linked folder ${target}. Merge the earlier settings into the intended destination before starting Vector.`,
        ),
      )
    const marker = path.join(target, "vector-migration.json")
    if (yield* fs.exists(marker)) continue
    const flock = yield* EffectFlock.Service
    const copied = yield* flock.withLock(
      Effect.gen(function* () {
        if (yield* fs.exists(marker)) return
        yield* fs.ensureDir(target)
        const imported = yield* run(folder.source, false, target)
        const local = yield* run(folder.source, true, target)
        if (imported) results.push(imported)
        if (local) results.push(local)
        for (const item of folder.files.filter(
          (file) =>
            assetNames.includes(file.name) ||
            ["tui.json", "tui.jsonc", "package.json", "AGENTS.md"].includes(file.name),
        )) {
          yield* copyAsset(path.join(folder.source, item.name), path.join(target, item.name))
        }
        yield* fs.writeFileString(marker, JSON.stringify({ source: folder.source, version: 1 }, null, 2), {
          mode: 0o600,
          flag: "wx",
        })
        const message = `Imported agent assets from ${folder.source} into ${target}. Original files were kept.`
        yield* Effect.logInfo(message)
        return { sources: [folder.source], target, message }
      }),
      `config-folder-import:${target}`,
    )
    if (copied) results.push(copied)
  }
  return results
})

const copyAsset: (source: string, target: string) => Effect.Effect<void, FSUtil.Error, FSUtil.Service> = Effect.fn(
  "ConfigMigration.copyAsset",
)(function* (source: string, target: string) {
  const fs = yield* FSUtil.Service
  if (
    (yield* fs.readDirectoryEntries(path.dirname(target))).find((entry) => entry.name === path.basename(target))
      ?.type === "symlink"
  )
    return yield* Effect.die(
      new Error(`Cannot replace linked settings at ${target}. Resolve the link before starting Vector.`),
    )
  const type = (yield* fs.readDirectoryEntries(path.dirname(source))).find(
    (entry) => entry.name === path.basename(source),
  )?.type
  if (type === "symlink")
    return yield* Effect.die(
      new Error(
        `Cannot safely import symbolic link ${source}. Copy its intended contents into ${target} before starting Vector.`,
      ),
    )
  if (type === "directory") {
    yield* fs.ensureDir(target)
    for (const child of yield* fs.readDirectoryEntries(source))
      yield* copyAsset(path.join(source, child.name), path.join(target, child.name))
    return
  }
  if (type !== "file")
    return yield* Effect.die(
      new Error(
        `Cannot import special file ${source}. Move the intended settings into ${target} before starting Vector.`,
      ),
    )
  if (yield* fs.exists(target)) {
    const original = yield* fs.readFile(source)
    const current = yield* fs.readFile(target)
    if (Buffer.from(original).equals(Buffer.from(current))) return
    return yield* Effect.die(
      new Error(
        `Existing settings at ${target} conflict with ${source}. Merge them before starting Vector; neither file was changed.`,
      ),
    )
  }
  const temporary = `${target}.${crypto.randomUUID()}.tmp`
  yield* fs.copyFile(source, temporary)
  yield* fs.rename(temporary, target).pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)))
})
