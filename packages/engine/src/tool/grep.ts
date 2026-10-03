import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string; include?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false },
            output: "No files found",
          }
          if (!params.pattern) {
            throw new Error("pattern is required")
          }

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
            },
          })

          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")
          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, requested, {
            bypass: false,
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })

          const search = FSUtil.resolve(requested)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const cwd = info?.type === "Directory" ? search : path.dirname(search)
          const limit = 100
          const result = yield* ripgrep.grep({
            cwd,
            pattern: params.pattern,
            // ripgrep searches a directory, so a file target has to be named
            // explicitly or every sibling in its directory gets searched too.
            file: info?.type === "Directory" ? undefined : path.basename(search),
            include: params.include,
            // One over the limit distinguishes "exactly limit matches" from
            // "more than we are showing"; only the first limit are reported.
            limit: limit + 1,
          })
          if (result.length === 0) return empty

          const truncated = result.length > limit
          const final = result.slice(0, limit).map((item) => {
            const absolute = path.resolve(cwd, item.entry.path)
            const relative = path.relative(ins.directory, absolute)
            // ripgrep keeps each line's newline, which printed a blank line after every match; a minified or generated
            // line can run to thousands of characters, so a match shows the 500 around what it matched.
            const text = item.text.replace(/\r?\n$/, "")
            // Submatch offsets count bytes, the window counts characters.
            const at = Buffer.from(text, "utf-8")
              .subarray(0, item.submatches[0]?.start ?? 0)
              .toString("utf-8").length
            return {
              // Relative to the working directory, which read, edit and write resolve against, when it is inside it.
              path: relative.startsWith("..") || path.isAbsolute(relative) ? absolute : relative,
              line: item.line,
              text: excerpt(text, at),
            }
          })

          const total = final.length
          const output = [`Found ${total} matches${truncated ? " (more matches available)" : ""}`]

          let current = ""
          for (const match of final) {
            if (current !== match.path) {
              if (current !== "") output.push("")
              current = match.path
              output.push(`${match.path}:`)
            }
            output.push(`  Line ${match.line}: ${match.text}`)
          }

          if (truncated) {
            output.push("")
            output.push("(Results truncated. Consider using a more specific path or pattern.)")
          }

          return {
            title: params.pattern,
            metadata: {
              matches: total,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// 500 characters of a long line around position `at`, marked where the line goes on.
function excerpt(text: string, at: number) {
  if (text.length <= 500) return text
  const start = Math.max(0, Math.min(at - 200, text.length - 500))
  return `${start > 0 ? "…" : ""}${text.slice(start, start + 500)}${start + 500 < text.length ? "…" : ""}`
}
