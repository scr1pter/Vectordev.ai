export * as ConfigImport from "./import-settings"

import path from "node:path"
import { Effect, Option } from "effect"
import { applyEdits, modify } from "jsonc-parser"
import { mergeDeep } from "remeda"
import { FSUtil } from "@vectordevai/core/fs-util"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { ConfigParse } from "./parse"
import { ConfigSchema } from "./schema"
import { GlobalBus } from "@/bus/global"
import { TuiEvent } from "@/server/tui-event"

const excluded = /^(?:vector|tui|package|auth|credential|secret|license)(?:[.-]|$)/i

export const run = Effect.fn("ConfigImport.run")(function* (directory: string, local = false) {
  const fs = yield* FSUtil.Service
  if (!(yield* fs.isDir(directory))) return
  const flock = yield* EffectFlock.Service
  return yield* flock.withLock(
    Effect.gen(function* () {
      const stem = local ? "vector.local" : "vector"
      const targets = [path.join(directory, `${stem}.json`), path.join(directory, `${stem}.jsonc`)]
      for (const target of targets) {
        const text = yield* fs.readFileStringSafe(target)
        if (!text) continue
        const data = ConfigParse.jsonc(text, target)
        if (data && typeof data === "object" && Object.keys(data).some((key) => key !== "$schema")) return
      }

      const entries = yield* fs.readDirectoryEntries(directory)
      const candidates = yield* Effect.forEach(
        entries.filter(
          (entry) =>
            entry.type === "file" &&
            !excluded.test(entry.name) &&
            (local
              ? /\.local\.jsonc?$/.test(entry.name)
              : /\.jsonc?$/.test(entry.name) && !/\.local\./.test(entry.name)),
        ),
        Effect.fnUntraced(function* (entry) {
          const file = path.join(directory, entry.name)
          const text = yield* fs.readFileString(file)
          const parsed = yield* Effect.try({ try: () => ConfigParse.jsonc(text, file), catch: (error) => error }).pipe(
            Effect.option,
          )
          if (Option.isNone(parsed) || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value))
            return
          const data = Object.fromEntries(
            Object.entries(parsed.value).filter(([key]) => !["theme", "keybinds", "tui"].includes(key)),
          )
          const decoded = yield* Effect.try({
            try: () => ConfigParse.schema(ConfigV1.Info, data, file),
            catch: (error) => error,
          }).pipe(Effect.option)
          if (Option.isNone(decoded)) {
            if (typeof data.$schema === "string" && data.$schema.endsWith("/config.json")) {
              return yield* Effect.die(
                new Error(`Cannot import settings from ${file}. Correct this config before starting Vector.`),
              )
            }
            return
          }
          if (!Object.keys(decoded.value).some((key) => key !== "$schema")) return
          return { file, name: entry.name, text, data: decoded.value }
        }),
      )
      const sources = candidates.filter((item) => item !== undefined)
      const families = new Set(
        sources.filter((item) => item.name !== "config.json").map((item) => item.name.replace(/\.jsonc?$/, "")),
      )
      if (!families.size) return
      if (families.size > 1) {
        return yield* Effect.die(
          new Error(
            `Multiple settings files found in ${directory}. Merge them into ${targets[1]} before starting Vector.`,
          ),
        )
      }
      const ordered = sources.toSorted(
        (a, b) =>
          Number(a.name !== "config.json") - Number(b.name !== "config.json") ||
          Number(a.name.endsWith(".jsonc")) - Number(b.name.endsWith(".jsonc")),
      )
      const merged = ordered.reduce<ConfigV1.Info>((result, item) => mergeDeep(result, item.data), {})
      const original = ordered.at(-1)!.text
      const text = Object.entries({ ...merged, $schema: "https://vectordev.ai/config.json" }).reduce(
        (result, [key, value]) =>
          applyEdits(result, modify(result, [key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
        ConfigSchema.rewrite(original),
      )
      if (local) {
        const gitignore = path.join(directory, ".gitignore")
        const existing = (yield* fs.readFileStringSafe(gitignore)) ?? ""
        const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()))
        const missing = targets.map((file) => path.basename(file)).filter((file) => !lines.has(file))
        if (missing.length) {
          yield* fs.writeFileString(gitignore, [existing.trimEnd(), ...missing].filter(Boolean).join("\n") + "\n")
        }
      }
      // Write beside the destination and rename atomically. Never change the source files.
      const temporary = `${targets[1]}.${crypto.randomUUID()}.tmp`
      yield* fs.writeFileString(temporary, text, { mode: 0o600, flag: "wx" })
      yield* fs.rename(temporary, targets[1]).pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)))
      const message = `Imported settings from ${ordered.map((item) => item.file).join(", ")} into ${targets[1]}. Original files were kept.`
      yield* Effect.logInfo(message)
      GlobalBus.emit("event", {
        directory: "global",
        payload: { type: TuiEvent.ToastShow.type, properties: { message, variant: "info", duration: 12000 } },
      })
      return { sources: ordered.map((item) => item.file), target: targets[1] }
    }),
    `config-import:${directory}:${local}`,
  )
})
