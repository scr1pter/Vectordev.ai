import { Context, Effect, FileSystem, Layer, Schema, Semaphore } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { secretFindings, SecretFindingSchema, type SecretFinding } from "./redaction.js"
import { CassetteSchema, encodeCassette, type Cassette, type CassetteMetadata, type Interaction } from "./schema.js"

const DEFAULT_RECORDINGS_DIR = path.resolve(process.cwd(), "test", "fixtures", "recordings")

export class CassetteNotFoundError extends Schema.TaggedErrorClass<CassetteNotFoundError>()("CassetteNotFoundError", {
  cassetteName: Schema.String,
}) {
  override get message() {
    return `Cassette "${this.cassetteName}" not found`
  }
}

export class UnsafeCassetteError extends Schema.TaggedErrorClass<UnsafeCassetteError>()("UnsafeCassetteError", {
  cassetteName: Schema.String,
  findings: Schema.Array(SecretFindingSchema),
}) {
  override get message() {
    return `Refusing to write cassette "${this.cassetteName}" because it contains possible secrets: ${this.findings
      .map((finding) => `${finding.path} (${finding.reason})`)
      .join(", ")}`
  }
}

export interface Interface {
  readonly read: (name: string) => Effect.Effect<ReadonlyArray<Interaction>, CassetteNotFoundError>
  readonly append: (
    name: string,
    interaction: Interaction,
    metadata?: CassetteMetadata,
  ) => Effect.Effect<void, UnsafeCassetteError>
  readonly exists: (name: string) => Effect.Effect<boolean>
  readonly list: () => Effect.Effect<ReadonlyArray<string>>
}

export class Service extends Context.Service<Service, Interface>()("@vectordevai/http-recorder/Cassette") {}

const cassettePath = (directory: string, name: string) => {
  if (!name || path.isAbsolute(name) || path.win32.isAbsolute(name) || name.split(/[\\/]/).includes(".."))
    throw new Error(`Invalid cassette name "${name}"`)
  const root = path.resolve(directory)
  const target = path.resolve(root, `${name}.json`)
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`Invalid cassette name "${name}"`)
  return target
}

export const hasCassetteSync = (name: string, options: { readonly directory?: string } = {}) =>
  fs.existsSync(cassettePath(options.directory ?? DEFAULT_RECORDINGS_DIR, name))

const buildCassette = (
  name: string,
  interactions: ReadonlyArray<Interaction>,
  metadata: CassetteMetadata | undefined,
): Cassette => ({
  version: 1,
  metadata: { name, recordedAt: new Date().toISOString(), ...metadata },
  interactions,
})

const formatCassette = (cassette: Cassette) => `${JSON.stringify(encodeCassette(cassette), null, 2)}\n`

const parseCassette = Schema.decodeUnknownSync(Schema.fromJsonString(CassetteSchema))

const failIfUnsafe = (name: string, findings: ReadonlyArray<SecretFinding>) =>
  findings.length === 0 ? Effect.void : Effect.fail(new UnsafeCassetteError({ cassetteName: name, findings }))

const interactionFindings = (interaction: Interaction) => [
  ...secretFindings(interaction),
  ...(interaction.transport === "websocket"
    ? interaction.events.flatMap((event, index) =>
        event.kind === "binary" ? [{ path: `events[${index}].body`, reason: "unreviewed binary WebSocket frame" }] : [],
      )
    : []),
]

const isSymbolicLink = (fs: FileSystem.FileSystem, candidate: string) =>
  fs.readLink(candidate).pipe(
    Effect.as(true),
    Effect.catch(() =>
      fs.stat(candidate).pipe(
        Effect.map((info) => info.type === "SymbolicLink"),
        Effect.catch(() => Effect.succeed(false)),
      ),
    ),
  )

const rejectSymbolicLinks = (fs: FileSystem.FileSystem, directory: string, target: string) => {
  const root = path.resolve(directory)
  const relative = path.relative(root, path.dirname(target))
  const parents = relative
    .split(path.sep)
    .filter(Boolean)
    .reduce<ReadonlyArray<string>>((paths, part) => [...paths, path.join(paths.at(-1) ?? root, part)], [root])
  return Effect.forEach(
    [...parents, target],
    (candidate) =>
      isSymbolicLink(fs, candidate).pipe(
        Effect.flatMap((symbolic) =>
          symbolic
            ? Effect.die(new Error(`Refusing to write cassette through symbolic link: ${candidate}`))
            : Effect.void,
        ),
      ),
    { discard: true },
  )
}

export const fileSystem = (
  options: { readonly directory?: string } = {},
): Layer.Layer<Service, never, FileSystem.FileSystem> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = options.directory ?? DEFAULT_RECORDINGS_DIR
      const recorded = new Map<string, { interactions: Interaction[]; findings: SecretFinding[] }>()
      const appendLock = yield* Semaphore.make(1)

      const pathFor = (name: string) => cassettePath(directory, name)

      const walk = (current: string): Effect.Effect<ReadonlyArray<string>> =>
        Effect.gen(function* () {
          const entries = yield* fs.readDirectory(current).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          const nested = yield* Effect.forEach(entries, (entry) => {
            const full = path.join(current, entry)
            return fs.stat(full).pipe(
              Effect.flatMap((stat) => (stat.type === "Directory" ? walk(full) : Effect.succeed([full]))),
              Effect.catch(() => Effect.succeed([] as string[])),
            )
          })
          return nested.flat()
        })

      return Service.of({
        read: (name) =>
          fs.readFileString(pathFor(name)).pipe(
            Effect.map((raw) => parseCassette(raw).interactions),
            Effect.catch(() => Effect.fail(new CassetteNotFoundError({ cassetteName: name }))),
          ),
        append: (name, interaction, metadata) =>
          appendLock.withPermit(
            Effect.gen(function* () {
              const entry = recorded.get(name) ?? { interactions: [], findings: [] }
              const interactions = [...entry.interactions, interaction]
              const currentFindings = [...entry.findings, ...interactionFindings(interaction)]
              const cassette = buildCassette(name, interactions, metadata)
              const findings = [...currentFindings, ...secretFindings(cassette.metadata ?? {})]
              yield* failIfUnsafe(name, findings)
              const target = pathFor(name)
              yield* rejectSymbolicLinks(fs, directory, target)
              yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(Effect.orDie)
              yield* rejectSymbolicLinks(fs, directory, target)
              const temporary = `${target}.${crypto.randomUUID()}.tmp`
              yield* fs.writeFileString(temporary, formatCassette(cassette), { flag: "wx" }).pipe(
                Effect.flatMap(() => rejectSymbolicLinks(fs, directory, target)),
                Effect.flatMap(() => fs.rename(temporary, target)),
                Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.catch(() => Effect.void))),
                Effect.orDie,
              )
              recorded.set(name, { interactions, findings: currentFindings })
            }),
          ),
        exists: (name) =>
          fs.access(pathFor(name)).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          ),
        list: () =>
          walk(directory).pipe(
            Effect.map((files) =>
              files
                .filter((file) => file.endsWith(".json"))
                .map((file) =>
                  path
                    .relative(directory, file)
                    .replace(/\\/g, "/")
                    .replace(/\.json$/, ""),
                )
                .toSorted((a, b) => a.localeCompare(b)),
            ),
          ),
      })
    }),
  )

export const memory = (initial: Record<string, ReadonlyArray<Interaction>> = {}): Layer.Layer<Service> =>
  Layer.sync(Service, () => {
    const stored = new Map<string, Interaction[]>(
      Object.entries(initial).map(([name, interactions]) => [name, [...interactions]]),
    )
    const accumulatedFindings = new Map<string, SecretFinding[]>()
    const appendLock = Semaphore.makeUnsafe(1)

    return Service.of({
      read: (name) =>
        stored.has(name)
          ? Effect.succeed(stored.get(name) ?? [])
          : Effect.fail(new CassetteNotFoundError({ cassetteName: name })),
      append: (name, interaction, metadata) =>
        appendLock.withPermit(
          Effect.suspend(() => {
            const interactions = [...(stored.get(name) ?? []), interaction]
            const findings = [...(accumulatedFindings.get(name) ?? []), ...interactionFindings(interaction)]
            const allFindings = metadata ? [...findings, ...secretFindings({ name, ...metadata })] : findings
            return failIfUnsafe(name, allFindings).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  stored.set(name, interactions)
                  accumulatedFindings.set(name, findings)
                }),
              ),
            )
          }),
        ),
      exists: (name) => Effect.sync(() => stored.has(name)),
      list: () => Effect.sync(() => Array.from(stored.keys()).toSorted()),
    })
  })
