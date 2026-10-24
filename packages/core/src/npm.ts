export * as Npm from "./npm"

import { existsSync, readFileSync, statSync } from "fs"
import path from "path"
import { pathToFileURL } from "url"
import npa from "npm-package-arg"
import { Effect, Schema, Context, Layer, Option, FileSystem, Predicate } from "effect"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { EffectFlock } from "./util/effect-flock"
import { makeGlobalNode } from "./effect/app-node"
import { filesystem } from "./effect/app-node-platform"
import { LayerNode } from "./effect/layer-node"
import { makeRuntime } from "./effect/runtime"
import { NpmConfig } from "./npm-config"
import { Egress } from "./local-mode/egress"
import { EgressAttribution } from "./local-mode/attribution"
import { EgressGuard } from "./local-mode/guard"

export class InstallFailedError extends Schema.TaggedErrorClass<InstallFailedError>()("NpmInstallFailedError", {
  add: Schema.Array(Schema.String).pipe(Schema.optional),
  dir: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface EntryPoint {
  readonly directory: string
  readonly entrypoint?: string
}

/** How a package is added: within a time limit, installed again, only from the cache, or within a Vector Local grant. */
export type AddOptions = {
  readonly timeout?: number
  readonly force?: boolean
  /** Only a copy installed earlier: nothing is installed and nothing connects. */
  readonly cached?: boolean
  /** The Vector Local grant the installer's requests run within (EgressAttribution.granted). */
  readonly grant?: Parameters<typeof EgressAttribution.granted>[0]
}

export interface Interface {
  readonly add: (
    pkg: string,
    options?: AddOptions,
  ) => Effect.Effect<EntryPoint, InstallFailedError | EffectFlock.LockError>
  /**
   * `add` for a package Vector installs for itself, decided as `source` while Vector Local is on (section 4.3.5): a copy
   * installed earlier loads as it is, and a missing one installs only when Vector Local lets `source` reach everything
   * the install reaches (the registry the npm config names for it, and the host of a git or tarball address). Otherwise
   * nothing starts that could connect, no installer and no git, and the error says why. With Vector Local off it is
   * `add`.
   */
  readonly addAs: (
    source: string,
    pkg: string,
    options?: Pick<AddOptions, "timeout" | "force">,
  ) => Effect.Effect<EntryPoint, InstallFailedError | EffectFlock.LockError>
  readonly install: (
    dir: string,
    input?: {
      add: {
        name: string
        version?: string
      }[]
    },
  ) => Effect.Effect<void, EffectFlock.LockError | InstallFailedError>
  readonly which: (
    pkg: string,
    bin?: string,
    options?: Pick<AddOptions, "cached" | "grant">,
  ) => Effect.Effect<string | undefined>
  /** `which`, decided as `source` the way `addAs` is: a missing package installs only when Vector Local allows it. */
  readonly whichAs: (source: string, pkg: string, bin?: string) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Npm") {}

const illegal = process.platform === "win32" ? new Set(["<", ">", ":", '"', "|", "?", "*"]) : undefined

export function sanitize(pkg: string) {
  if (!illegal) return pkg
  return Array.from(pkg, (char) => (illegal.has(char) || char.charCodeAt(0) < 32 ? "_" : char)).join("")
}

const resolveEntryPoint = (name: string, dir: string): EntryPoint => {
  let entrypoint: string | undefined
  try {
    // Node's import.meta.resolve takes no parent URL without a flag, so on Node (the desktop engine) it resolves the
    // package directory itself, which import() rejects with ERR_UNSUPPORTED_DIR_IMPORT.
    entrypoint = typeof Bun !== "undefined" ? import.meta.resolve(name, dir) : packageEntry(dir)
  } catch {
    entrypoint = undefined
  }
  return {
    directory: dir,
    entrypoint,
  }
}

const EXPORT_CONDITIONS = new Set(["node", "import", "default"])

// The file Node's ESM loader would import for the package installed at `dir`, as a file: URL: the "." export under
// the node/import/default conditions, else `main`, else index.js. Undefined when none of them is a file.
export function packageEntry(dir: string) {
  const manifest = readManifest(dir)
  const exported = exportTarget(manifest?.exports)
  const main = typeof manifest?.main === "string" ? manifest.main.trim() : ""
  const file = [
    ...(exported ? [exported] : []),
    ...(main ? [main, `${main}.js`, path.join(main, "index.js")] : []),
    "index.js",
  ]
    .map((value) => path.resolve(dir, value))
    .find((file) => statSync(file, { throwIfNoEntry: false })?.isFile())
  return file ? pathToFileURL(file).href : undefined
}

function readManifest(dir: string) {
  const file = path.join(dir, "package.json")
  if (!existsSync(file)) return undefined
  const value = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(readFileSync(file, "utf8")),
  )
  return Predicate.isObject(value) ? value : undefined
}

// Condition keys are matched in package order, as Node does, so `{ require, import }` still picks import.
function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(exportTarget).find((item) => item !== undefined)
  if (!Predicate.isObject(value)) return undefined
  if (Object.keys(value).some((key) => key.startsWith("."))) return exportTarget(value["."])
  return Object.entries(value)
    .filter((entry) => EXPORT_CONDITIONS.has(entry[0]))
    .map((entry) => exportTarget(entry[1]))
    .find((item) => item !== undefined)
}

interface ArboristNode {
  name: string
  path: string
}

interface ArboristTree {
  edgesOut: Map<string, { to?: ArboristNode }>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const afs = yield* FSUtil.Service
    const global = yield* Global.Service
    const fs = yield* FileSystem.FileSystem
    const flock = yield* EffectFlock.Service
    const directory = (pkg: string) => path.join(global.cache, "packages", sanitize(pkg))
    const reify = (input: { dir: string; add?: string[]; timeout?: number; grant?: AddOptions["grant"] }) =>
      Effect.gen(function* () {
        yield* flock.acquire(`npm-install:${input.dir}`)
        const { Arborist } = yield* Effect.promise(() => import("@npmcli/arborist"))
        const add = input.add ?? []
        const npmOptions = yield* NpmConfig.load(input.dir)
        return yield* Effect.tryPromise({
          try: (signal) => {
            // Arborist passes constructor options through pacote to registry fetches.
            const options = {
              ...npmOptions,
              signal:
                input.timeout === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(input.timeout)]),
              ...(input.timeout === undefined
                ? {}
                : { timeout: input.timeout, fetchRetries: 0, retry: { retries: 0 } }),
              path: input.dir,
              binLinks: true,
              progress: false,
              savePrefix: "",
              ignoreScripts: true,
            }
            const run = () =>
              new Arborist(options).reify({
                ...options,
                add,
                save: true,
                saveType: "prod",
              })
            return input.grant ? EgressAttribution.granted(input.grant, run) : run()
          },
          catch: (cause) =>
            new InstallFailedError({
              cause,
              add,
              dir: input.dir,
            }),
        }) as Effect.Effect<ArboristTree, InstallFailedError>
      }).pipe(
        Effect.interruptible,
        Effect.withSpan("Npm.reify", {
          attributes: { dir: input.dir, add: input.add, timeout: input.timeout },
        }),
      )

    const add: Interface["add"] = Effect.fn("Npm.add")(function* (pkg, options) {
      const dir = directory(pkg)
      const name = (() => {
        try {
          return npa(pkg).name ?? pkg
        } catch {
          return pkg
        }
      })()

      if (!options?.force && (yield* afs.existsSafe(path.join(dir, "node_modules", name)))) {
        return resolveEntryPoint(name, path.join(dir, "node_modules", name))
      }
      if (options?.cached) return yield* new InstallFailedError({ add: [pkg], dir })

      const tree = yield* reify({ dir, add: [pkg], timeout: options?.timeout, grant: options?.grant })
      const first = tree.edgesOut.values().next().value?.to
      if (!first) {
        const result = resolveEntryPoint(name, path.join(dir, "node_modules", name))
        if (result.entrypoint) return result
        return yield* new InstallFailedError({ add: [pkg], dir })
      }
      return resolveEntryPoint(first.name, first.path)
    }, Effect.scoped)

    const install: Interface["install"] = Effect.fn("Npm.install")(function* (dir, input) {
      const canWrite = yield* afs.access(dir, { writable: true }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (!canWrite) return

      const add = input?.add.map((pkg) => [pkg.name, pkg.version].filter(Boolean).join("@")) ?? []
      if (
        yield* Effect.gen(function* () {
          const nodeModulesExists = yield* afs.existsSafe(path.join(dir, "node_modules"))
          if (!nodeModulesExists) {
            yield* reify({ add, dir })
            return true
          }
          return false
        }).pipe(Effect.withSpan("Npm.checkNodeModules"))
      )
        return

      yield* Effect.gen(function* () {
        const pkg = yield* afs.readJson(path.join(dir, "package.json")).pipe(Effect.orElseSucceed(() => ({})))
        const lock = yield* afs.readJson(path.join(dir, "package-lock.json")).pipe(Effect.orElseSucceed(() => ({})))

        const pkgAny = pkg as any
        const lockAny = lock as any
        const declared = new Set([
          ...Object.keys(pkgAny?.dependencies || {}),
          ...Object.keys(pkgAny?.devDependencies || {}),
          ...Object.keys(pkgAny?.peerDependencies || {}),
          ...Object.keys(pkgAny?.optionalDependencies || {}),
          ...(input?.add || []).map((pkg) => pkg.name),
        ])

        const root = lockAny?.packages?.[""] || {}
        const locked = new Set([
          ...Object.keys(root?.dependencies || {}),
          ...Object.keys(root?.devDependencies || {}),
          ...Object.keys(root?.peerDependencies || {}),
          ...Object.keys(root?.optionalDependencies || {}),
        ])

        for (const name of declared) {
          if (!locked.has(name)) {
            yield* reify({ dir, add })
            return
          }
        }
      }).pipe(Effect.withSpan("Npm.checkDirty"))

      return
    }, Effect.scoped)

    // Where installing `pkg` reaches, as http(s) addresses Vector Local decides: the registry the npm config names for
    // it (its scope's own, if it has one), where every dependency comes from, and the host of a git or tarball address.
    // Undefined when Vector cannot tell, which is refused.
    const reaches = Effect.fnUntraced(function* (pkg: string) {
      const parsed = (() => {
        try {
          return npa(pkg)
        } catch {
          return undefined
        }
      })()
      if (!parsed) return undefined
      const config = yield* NpmConfig.load(directory(pkg))
      const scoped = parsed.scope ? config[`${parsed.scope}:registry`] : undefined
      const named = typeof scoped === "string" ? scoped : config.registry
      const registry = typeof named === "string" && URL.canParse(named) ? named : "https://registry.npmjs.org/"
      if (parsed.type !== "git" && parsed.type !== "remote") return [new URL(registry)]
      const host =
        parsed.type === "git"
          ? gitHost(parsed)
          : URL.canParse(parsed.fetchSpec ?? "")
            ? new URL(parsed.fetchSpec!).host
            : undefined
      return host ? [new URL(registry), new URL(`https://${host}/`)] : undefined
    })

    // Decides installing `pkg` as `source` under Vector Local, and logs it: the grant to install within, or why not.
    const decide = Effect.fnUntraced(function* (source: string, pkg: string) {
      const urls = yield* reaches(pkg)
      if (!urls) return { reason: "Vector cannot tell where this package comes from." }
      const decided = urls.map((url) => Egress.decide({ source, url: url.href }))
      const refused = decided.find((item) => item.decision !== "allow")
      if (refused) return { reason: refused.reason }
      return {
        grant: { source, purpose: decided[0]!.purpose, grants: urls.flatMap((url) => EgressGuard.destinations(url)) },
      }
    })

    const addAs: Interface["addAs"] = Effect.fn("Npm.addAs")(function* (source, pkg, options) {
      if (!Egress.policy().enabled) return yield* add(pkg, options)
      if (!options?.force) {
        const cached = yield* add(pkg, { cached: true }).pipe(Effect.option)
        if (Option.isSome(cached)) return cached.value
      }
      const decided = yield* decide(source, pkg)
      if (!decided.grant)
        return yield* new InstallFailedError({
          add: [pkg],
          dir: directory(pkg),
          cause: new Error(`Vector Local did not install ${pkg}. ${decided.reason}`),
        })
      return yield* add(pkg, { ...options, grant: decided.grant })
    })

    const which = Effect.fn("Npm.which")(function* (
      pkg: string,
      bin?: string,
      options?: Pick<AddOptions, "cached" | "grant">,
    ) {
      const dir = directory(pkg)
      const binDir = path.join(dir, "node_modules", ".bin")

      const pick = Effect.fnUntraced(function* () {
        const files = yield* fs.readDirectory(binDir).pipe(Effect.catch(() => Effect.succeed([] as string[])))

        if (files.length === 0) return Option.none<string>()
        // Caller picked a specific bin (e.g. pyright exposes both `pyright` and
        // `pyright-langserver`); trust the hint if the package provides it.
        if (bin) return files.includes(bin) ? Option.some(bin) : Option.none<string>()
        if (files.length === 1) return Option.some(files[0])

        const pkgJson = yield* afs.readJson(path.join(dir, "node_modules", pkg, "package.json")).pipe(Effect.option)

        if (Option.isSome(pkgJson)) {
          const parsed = pkgJson.value as { bin?: string | Record<string, string> }
          if (parsed?.bin) {
            const unscoped = pkg.startsWith("@") ? pkg.split("/")[1] : pkg
            const parsedBin = parsed.bin
            if (typeof parsedBin === "string") return Option.some(unscoped)
            const keys = Object.keys(parsedBin)
            if (keys.length === 1) return Option.some(keys[0])
            return parsedBin[unscoped] ? Option.some(unscoped) : Option.some(keys[0])
          }
        }

        return Option.some(files[0])
      })

      return Option.getOrUndefined(
        yield* Effect.gen(function* () {
          const bin = yield* pick()
          if (Option.isSome(bin)) {
            return Option.some(path.join(binDir, bin.value))
          }

          if (options?.cached) return Option.none<string>()
          yield* fs.remove(path.join(dir, "package-lock.json")).pipe(Effect.orElseSucceed(() => {}))

          yield* add(pkg, { grant: options?.grant })

          const resolved = yield* pick()
          if (Option.isNone(resolved)) return Option.none<string>()
          return Option.some(path.join(binDir, resolved.value))
        }).pipe(
          Effect.scoped,
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
      )
    })

    const whichAs: Interface["whichAs"] = Effect.fn("Npm.whichAs")(function* (source, pkg, bin) {
      if (!Egress.policy().enabled) return yield* which(pkg, bin)
      const cached = yield* which(pkg, bin, { cached: true })
      if (cached) return cached
      const decided = yield* decide(source, pkg)
      if (!decided.grant) return undefined
      return yield* which(pkg, bin, { grant: decided.grant })
    })

    return Service.of({
      add,
      addAs,
      install,
      which,
      whichAs,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Global.node, filesystem, EffectFlock.node],
})

const { runPromise } = makeRuntime(Service, LayerNode.compile(node))

export async function install(...args: Parameters<Interface["install"]>) {
  return runPromise((svc) => svc.install(...args))
}

export async function add(...args: Parameters<Interface["add"]>) {
  return runPromise((svc) => svc.add(...args))
}

export async function which(...args: Parameters<Interface["which"]>) {
  return runPromise((svc) => svc.which(...args))
}

export async function addAs(...args: Parameters<Interface["addAs"]>) {
  return runPromise((svc) => svc.addAs(...args))
}

export async function whichAs(...args: Parameters<Interface["whichAs"]>) {
  return runPromise((svc) => svc.whichAs(...args))
}

// The host a git package address names: a known host's (github:org/x), or the one in its URL or scp-style address.
function gitHost(parsed: ReturnType<typeof npa>) {
  const hosted = (parsed.hosted as { readonly domain?: string } | undefined)?.domain
  if (hosted) return hosted
  const spec = (parsed.fetchSpec ?? "").replace(/^git\+/, "")
  if (URL.canParse(spec)) return new URL(spec).host || undefined
  return /^(?:[^@/]+@)?([^:/]+):/.exec(spec)?.[1]
}
