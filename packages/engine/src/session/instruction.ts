import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import path from "path"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Effect, Layer, Context, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@vectordevai/core/flag/flag"
import { FSUtil } from "@vectordevai/core/fs-util"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@vectordevai/core/global"
import { WebFetchRequest } from "@vectordevai/core/util/webfetch-request"
import { collectBoundedResponseBody } from "@vectordevai/core/tool/http-body"
import { containsPath } from "@/project/instance-context"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainPaths } from "@vectordevai/core/brain/paths"
import { Project } from "@vectordevai/core/project"
import type { MessageID } from "./schema"

/** Memory entries attached to a read result are recorded in its `loaded` metadata as `memory:<id>,<id>`. */
export const MEMORY_LOADED = "memory:"

function extract(messages: SessionV1.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p !== "string") continue
          if (!p.startsWith(MEMORY_LOADED)) {
            paths.add(p)
            continue
          }
          for (const id of p.slice(MEMORY_LOADED.length).split(",")) paths.add(`${MEMORY_LOADED}${id}`)
        }
      }
    }
  }
  return paths
}

/** The memory entries already attached to read results in this history. */
export function attachedMemory(messages: SessionV1.WithParts[]) {
  return new Set(
    [...extract(messages)].flatMap((item) => (item.startsWith(MEMORY_LOADED) ? [item.slice(MEMORY_LOADED.length)] : [])),
  )
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  /** Where this instance's requests run, as the brain needs it: the repository, its rules and memory files, trust. */
  readonly place: () => Effect.Effect<Brain.Place>
  readonly systemPaths: () => Effect.Effect<Set<string>, FSUtil.Error>
  readonly system: () => Effect.Effect<string[], FSUtil.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, FSUtil.Error>
  readonly resolve: (
    messages: SessionV1.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Instruction") {}

const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service | Brain.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const brain = yield* Brain.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = [
      "AGENTS.md",
      ...(!flags.disableClaudeCodePrompt ? ["CLAUDE.md"] : []),
      "CONTEXT.md", // deprecated
    ]
    // RULES.md (repository and global), MEMORY.md and the legacy BRAIN.md are no longer loaded whole here: the brain
    // mirrors them and sends rules whole, MEMORY.md to its budget, and the rest only when relevant (see Brain).
    const memoryFiles = [
      { file: ".vector/RULES.md", type: "rules" as const },
      { file: ".vector/BRAIN.md", type: "brain" as const },
      { file: "BRAIN.md", type: "brain" as const },
    ]

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
        }),
      ),
    )

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.VECTOR_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      return (yield* fs.readFileStringSafe(filepath)) ?? ""
    })

    // Every instruction file goes to the model with the system prompt, and a repository can ship AGENTS.md as a link to
    // ../../.ssh/id_rsa. A file inside the project is read only where it really lands inside the project; one found
    // above a directory that is not a git repository is the user's own.
    const landsInProject = Effect.fnUntraced(function* (file: string) {
      const ctx = yield* InstanceState.context
      if (!containsPath(file, ctx)) return true
      // A link that cannot be resolved (a loop) cannot be read either, and the read reports it.
      const resolved = yield* Effect.try({ try: () => FSUtil.realpath(file), catch: (error) => error }).pipe(
        Effect.option,
      )
      if (Option.isNone(resolved)) return true
      const target = resolved.value
      if (
        containsPath(target, {
          ...ctx,
          directory: FSUtil.realpath(ctx.directory),
          worktree: FSUtil.realpath(ctx.worktree),
        })
      )
        return true
      yield* Effect.logWarning("not loading a project instruction file that links outside the project", { file, target })
      return false
    })

    const projectFiles = (found: Effect.Effect<string[], unknown>) =>
      found.pipe(
        Effect.catch(() => Effect.succeed([] as string[])),
        Effect.flatMap((matches) => Effect.filter(matches, landsInProject)),
      )

    const fetch = Effect.fnUntraced(function* (url: string) {
      // Instruction URLs come from the user's own config (or a project they trusted), so an intranet page is fine.
      return yield* WebFetchRequest.execute(http, HttpClientRequest.get(url), {
        authorize: () => Effect.void,
        authorizePrivate: () => Effect.void,
      }).pipe(
        Effect.flatMap((response) =>
          collectBoundedResponseBody(response, 1024 * 1024, () => new Error("Remote instructions exceed 1 MiB")),
        ),
        Effect.map((body) => new TextDecoder().decode(body)),
        Effect.scoped,
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed("")),
      )
    })

    const place = Effect.fn("Instruction.place")(function* () {
      const ctx = yield* InstanceState.context
      // A repository's rules and memory are still its own files, so VECTOR_DISABLE_PROJECT_CONFIG skips them: a code
      // review runs on a pull request's tree and must not take instructions from it.
      const sources = Flag.VECTOR_DISABLE_PROJECT_CONFIG
        ? []
        : yield* Effect.forEach(memoryFiles, (item) =>
            projectFiles(fs.findUp(item.file, ctx.directory, ctx.worktree)).pipe(
              Effect.map((matches) => matches.map((match) => ({ path: path.resolve(match), type: item.type }))),
            ),
          ).pipe(Effect.map((found) => found.flat()))
      const trust = yield* cfg.trust()
      return {
        // Every worktree and Parallel Workspace of a repository shares its memory; a folder outside git has its own.
        repository: ctx.project.id === Project.ID.global ? BrainPaths.folderKey(ctx.directory) : ctx.project.id,
        root: ctx.worktree === "/" ? ctx.directory : ctx.worktree,
        sources,
        // Memory a repository ships waits for review while its own settings are untrusted.
        held: !trust.trusted && trust.settings,
      } satisfies Brain.Place
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.VECTOR_DISABLE_PROJECT_CONFIG) {
        for (const file of instructionFiles) {
          const matches = yield* projectFiles(fs.findUp(file, ctx.directory, ctx.worktree))
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs
                  .glob(path.basename(instruction), {
                    cwd: path.dirname(instruction),
                    absolute: true,
                    include: "file",
                  })
                  .pipe(Effect.catch(() => Effect.succeed([] as string[])))
              : projectFiles(relative(instruction))
          )
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      return paths
    })

    const system = Effect.fn("Instruction.system")(function* () {
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      return [
        ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
      ]
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const sys = yield* systemPaths()
      const already = extract(messages)
      const results: { filepath: string; content: string }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let current = path.dirname(target)

      // Walk upward from the file being read and attach nearby instruction files once per message.
      while (current.startsWith(root) && current !== root) {
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found) || !(yield* landsInProject(found))) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const content = yield* read(found)
        if (content) {
          results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
        }

        current = path.dirname(current)
      }

      // Scoped rules and memory about this file come with it, once per session: the rule for src/routes/** when a
      // route is read, the repair a repeated failure needed when a file it touched is read.
      const claimed = s.claims.get(messageID) ?? new Set<string>()
      const attached = yield* brain.attach(yield* place(), {
        file: target,
        personal: false,
        exclude: new Set(
          [...already, ...claimed].flatMap((item) =>
            item.startsWith(MEMORY_LOADED) ? [item.slice(MEMORY_LOADED.length)] : [],
          ),
        ),
      })
      if (attached.text) {
        attached.ids.forEach((id) => claimed.add(`${MEMORY_LOADED}${id}`))
        s.claims.set(messageID, claimed)
        results.push({ filepath: `${MEMORY_LOADED}${attached.ids.join(",")}`, content: attached.text })
      }

      return results
    })

    return Service.of({ clear, place, systemPaths, system, find, resolve })
  }),
)

export function loaded(messages: SessionV1.WithParts[]) {
  return extract(messages)
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, FSUtil.node, Global.node, RuntimeFlags.node, httpClient, Brain.node],
})

export * as Instruction from "./instruction"
