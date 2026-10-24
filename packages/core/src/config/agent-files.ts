export * as ConfigAgentFiles from "./agent-files"

import path from "path"
import { Effect, Option, Schema } from "effect"
import { Config } from "../config"
import { FSUtil } from "../fs-util"
import { ConfigAgentV1 } from "../v1/config/agent"
import { ConfigMigrateV1 } from "../v1/config/migrate"
import { ConfigAgent } from "./agent"
import { ConfigMarkdown } from "./markdown"

// Agents a config directory keeps as Markdown files: `agent/` and `agents/` hold agents, `mode/` and `modes/` primary
// ones. The file's body is the agent's system prompt. A file with keys the current format does not know is read in the
// legacy format and migrated.
const sources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info)
const decodeLegacyAgent = Schema.decodeUnknownOption(ConfigAgentV1.Info)
const decodeConfig = Schema.decodeUnknownOption(Config.Info)
const agentKeys = new Set([
  "model",
  "variant",
  "request",
  "system",
  "description",
  "mode",
  "hidden",
  "color",
  "steps",
  "disabled",
  "permissions",
])

/** The agent files of a config directory, each as a config document with that one agent, in file order. */
export function documents(fs: FSUtil.Interface, directory: string) {
  return Effect.forEach(sources, (source) =>
    fs
      .glob(source.pattern, { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(
        Effect.map((files) => files.toSorted().map((filepath) => ({ directory, filepath, primary: source.primary }))),
      ),
  ).pipe(
    Effect.map((files) => files.flat()),
    Effect.catch(() => Effect.succeed([])),
    Effect.flatMap((files) =>
      Effect.forEach(files, (file) =>
        fs.readFileStringSafe(file.filepath).pipe(
          Effect.map((content) => (content ? decode(file, content) : undefined)),
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      ),
    ),
    Effect.map((documents) => documents.filter((document): document is Config.Document => document !== undefined)),
  )
}

function decode(file: { directory: string; filepath: string; primary: boolean }, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const name = path
    .relative(file.directory, file.filepath)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents|mode|modes)\//, "")
    .replace(/\.md$/, "")
  const body = markdown.content.trim()
  const legacy = Object.keys(markdown.data).some((key) => !agentKeys.has(key))
  const agent = Option.getOrUndefined(
    legacy
      ? Option.map(
          decodeLegacyAgent({ name, ...markdown.data, prompt: body }, { errors: "all", propertyOrder: "original" }),
          ConfigMigrateV1.migrateAgent,
        )
      : decodeAgent({ ...markdown.data, system: body }, { errors: "all", propertyOrder: "original" }),
  )
  if (!agent) return
  const info = Option.getOrUndefined(
    decodeConfig({
      agents: { [name]: file.primary ? { ...agent, mode: "primary" } : agent },
    }),
  )
  if (!info) return
  return new Config.Document({ type: "document", path: file.filepath, info })
}
