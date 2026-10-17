import path from "path"
import { type ParseError as JsoncParseError, applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { unique, uniqueBy } from "remeda"
import { Option, Schema } from "effect"
import { TuiConfig } from "@vectordevai/tui/config"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { Filesystem } from "@/util/filesystem"
import { ConfigPaths } from "@/config/paths"

const TUI_SCHEMA_URL = "https://vectordev.ai/tui.json"

const decodeTheme = Schema.decodeUnknownOption(Schema.String)
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeScrollSpeed = Schema.decodeUnknownOption(TuiConfig.ScrollSpeed)
const decodeScrollAcceleration = Schema.decodeUnknownOption(TuiConfig.ScrollAcceleration)
const decodeDiffStyle = Schema.decodeUnknownOption(TuiConfig.DiffStyle)

interface MigrateInput {
  cwd: string
  /** The canonical workspace: project files are written only where they really are inside it. */
  workspace: string
  worktree?: string
  directories: string[]
  /** VECTOR_AGENT_CONFIG and VECTOR_AGENT_CONFIG_DIR as ConfigPaths.environmentPath classified them. */
  agentConfig?: { path: string; project: boolean }
  agentDirectory?: { path: string; project: boolean }
}

/**
 * Migrates tui-specific keys (theme, keybinds, tui) from vector.json files
 * into dedicated tui.json files. Migration is performed per-directory and
 * skips only locations where a tui.json already exists.
 *
 * This runs before the workspace is trusted, and writing follows links. A file is migrated only when every file it
 * writes is a plain file that really lands inside its owner: the workspace for project files, or the user's own
 * config directory for theirs.
 */
export async function migrateTuiConfig(input: MigrateInput) {
  const vector = await vectorFiles(input)
  for (const { file, root } of vector) {
    const source = await Filesystem.readText(file).catch(() => undefined)
    if (!source) continue
    const errors: JsoncParseError[] = []
    const data = parseJsonc(source, errors, { allowTrailingComma: true })
    if (errors.length || !data || typeof data !== "object" || Array.isArray(data)) continue

    const theme = decodeTheme("theme" in data ? data.theme : undefined)
    const keybinds = decodeRecord("keybinds" in data ? data.keybinds : undefined)
    const legacyTui = decodeRecord("tui" in data ? data.tui : undefined)
    const extracted = {
      theme: Option.getOrUndefined(theme),
      keybinds: Option.getOrUndefined(keybinds),
      tui: Option.getOrUndefined(legacyTui),
    }
    const tui = extracted.tui ? normalizeTui(extracted.tui) : undefined
    if (extracted.theme === undefined && extracted.keybinds === undefined && !tui) continue

    const target = path.join(path.dirname(file), "tui.json")
    const targetExists = await Filesystem.exists(target)
    if (targetExists) continue
    // Earlier explicitly selected files remain intact; only Vector copies are rewritten.
    const strip = ["vector.json", "vector.jsonc"].includes(path.basename(file))
    if (
      [target, ...(strip ? [file, file + ".tui-migration.bak"] : [])].some((item) => !FSUtil.writableInside(root, item))
    )
      continue

    const payload: Record<string, unknown> = {
      $schema: TUI_SCHEMA_URL,
    }
    if (extracted.theme !== undefined) payload.theme = extracted.theme
    if (extracted.keybinds !== undefined) payload.keybinds = extracted.keybinds
    if (tui) Object.assign(payload, tui)

    const wrote = await Filesystem.write(target, JSON.stringify(payload, null, 2))
      .then(() => true)
      .catch(() => false)
    if (!wrote || !strip) continue
    await backupAndStripLegacy(file, source)
  }
}

function normalizeTui(data: Record<string, unknown>):
  | {
      scroll_speed: number | undefined
      scroll_acceleration: { enabled: boolean } | undefined
      diff_style: "auto" | "stacked" | undefined
    }
  | undefined {
  const parsed = {
    scroll_speed: Option.getOrUndefined(decodeScrollSpeed(data.scroll_speed)),
    scroll_acceleration: Option.getOrUndefined(decodeScrollAcceleration(data.scroll_acceleration)),
    diff_style: Option.getOrUndefined(decodeDiffStyle(data.diff_style)),
  }
  return parsed.scroll_speed === undefined &&
    parsed.diff_style === undefined &&
    parsed.scroll_acceleration === undefined
    ? undefined
    : parsed
}

async function backupAndStripLegacy(file: string, source: string) {
  const backup = file + ".tui-migration.bak"
  const hasBackup = await Filesystem.exists(backup)
  const backed = hasBackup
    ? true
    : await Filesystem.write(backup, source)
        .then(() => true)
        .catch(() => false)
  if (!backed) return false

  const text = ["theme", "keybinds", "tui"].reduce((acc, key) => {
    const edits = modify(acc, [key], undefined, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    if (!edits.length) return acc
    return applyEdits(acc, edits)
  }, source)

  return Filesystem.write(file, text)
    .then(() => true)
    .catch(() => false)
}

async function vectorFiles(input: MigrateInput) {
  // The user's own config directories, written only inside themselves even when they sit inside the workspace.
  const own = [
    Global.Path.config,
    path.join(Global.Path.home, ".vector"),
    ...(input.agentDirectory && !input.agentDirectory.project ? [input.agentDirectory.path] : []),
  ]
  const files = [
    ...ConfigPaths.fileInDirectory(Global.Path.config, "vector").map((file) => ({ file, root: Global.Path.config })),
    // A file in a folder above a non-git workspace, whose settings load with the project's, is written only inside
    // that folder.
    ...(await Filesystem.findUp(["vector.json", "vector.jsonc"], input.cwd, input.worktree, { rootFirst: true })).map(
      (file) => ({ file, root: FSUtil.contains(input.workspace, file) ? input.workspace : path.dirname(file) }),
    ),
    ...unique(input.directories).flatMap((dir) =>
      ConfigPaths.fileInDirectory(dir, "vector").map((file) => ({
        file,
        // A folder above a non-git workspace is written only inside the folder that holds it, so a .vector there
        // that links away is never written through.
        root: own.includes(dir) ? dir : FSUtil.contains(input.workspace, dir) ? input.workspace : path.dirname(dir),
      })),
    ),
    ...(input.agentConfig
      ? [
          {
            file: input.agentConfig.path,
            root: input.agentConfig.project ? input.workspace : path.dirname(input.agentConfig.path),
          },
        ]
      : []),
  ]

  const existing = await Promise.all(
    uniqueBy(files, (item) => item.file).map(async (item) => ((await Filesystem.exists(item.file)) ? item : undefined)),
  )
  return existing.filter((item) => item !== undefined)
}
