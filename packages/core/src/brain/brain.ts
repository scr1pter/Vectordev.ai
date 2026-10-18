export * as Brain from "./brain"

import { createHash, randomBytes } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { and, asc, desc, eq, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm"
import { EffectDrizzleSqlite } from "@vectordevai/effect-drizzle-sqlite"
import { layer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { InstallationChannel } from "../installation/version"
import { DatabaseMigration } from "../database/migration"
import { Glob } from "../util/glob"
import { Token } from "../util/token"
import { BrainLexical } from "./lexical"
import { BrainParse } from "./parse"
import { BrainPaths } from "./paths"
import { BrainScan } from "./scan"
import type { BrainSchema } from "./schema"
import {
  BrainEntryTable,
  BrainEventTable,
  BrainEvidenceTable,
  BrainSourceTable,
  BrainStateTable,
  BrainTombstoneTable,
  BrainUseTable,
} from "./sql"
import first from "./migration/20261018000000_brain"

// The Vector brain: one local store for everything durable that steers the agent. Files people write stay theirs and
// are only ever read (repository and personal RULES.md, MEMORY.md, the legacy BRAIN.md); what Vector learns lives in
// brain.db on this computer. Everything on the request path is deterministic code over a few hundred entries, so it
// costs no model call and adds tokens only when something is relevant:
//
// - Tier 0, `digest`: rules, MEMORY.md (to its budget), pinned entries and one index line, byte-stable for a session so
//   the provider's prompt cache keeps it. Nothing at all when there is nothing to say.
// - Tier 1, `recall` once per request message and `attach` when a file is read: BM25 over entries, within a budget set
//   by the request's size; nothing when nothing scores.
// - Tier 2, `search` and `get`: the memory tool, when the agent decides to look.

export const LIMIT = {
  /** Characters of one entry the agent writes; a person may write more. */
  agent: 300,
  user: 1_000,
  /** Active learned entries per repository and for the personal scope; tidying archives the least used past this. */
  repository: 300,
  personal: 120,
  /** Entries the agent may make active per request message; the rest wait as proposals. */
  perMessage: 3,
  /** Bytes read from one mirrored file. */
  file: 256 * 1024,
} as const

export const BUDGET = {
  /** Tokens of MEMORY.md in the cached prefix; the rest of it is recalled when relevant. */
  memory: 800,
  /** Tokens of pinned entries in the cached prefix. */
  pinned: 300,
  /** Tokens attached when a file is read. */
  attach: 200,
  /** Characters of one search result set. */
  search: 1_200,
} as const

/** Tokens recalled for a request of each size. A greeting recalls nothing. */
export function recallBudget(tier: "chat" | "light" | "standard" | "thorough") {
  return { chat: 0, light: 200, standard: 300, thorough: 500 }[tier]
}

export type Source = { readonly path: string; readonly type: "rules" | "brain" }

/** Where a request runs, as the brain needs it. Built by the engine from its instance. */
export type Place = {
  /** The repository's ID (shared by its worktrees and Parallel Workspaces), or a folder key outside git. */
  readonly repository: string
  /** The working tree's root, where its failure memory is keyed. */
  readonly root: string
  /** The repository's rules files and legacy BRAIN.md files found for this location. */
  readonly sources: readonly Source[]
  /** The repository has settings the user has not trusted, so memory it ships is held for review. */
  readonly held: boolean
}

export type Evidence =
  | { readonly type: "user" }
  | { readonly type: "message"; readonly quote: string; readonly verified: boolean }
  | {
      readonly type: "file"
      readonly path: string
      readonly quote: string
      readonly hash?: string
      readonly verified: boolean
    }
  | { readonly type: "check"; readonly command: string; readonly verified: boolean }

export type Proposal = {
  readonly kind: BrainSchema.LearnedKind
  readonly text: string
  readonly scope: BrainSchema.Scope
  readonly paths?: readonly string[]
  readonly evidence?: Evidence
  /** The entry this one replaces. */
  readonly supersedes?: string
  readonly origin: "agent" | "user"
  readonly sessionID?: string
  /** Entries this session's current request message may still make active, counted by the caller. */
  readonly since?: number
  /** Why the caller holds this write for review: the session read untrusted content, or a guest drove it. */
  readonly hold?: BrainSchema.Hold
}

export type Refusal = "secret" | "forgotten" | "empty" | "too-long" | "learning-off" | "file-entry" | "not-found"

export type WriteResult =
  | { readonly type: "added" | "merged" | "promoted" | "proposed" | "held"; readonly entry: BrainSchema.Entry }
  | { readonly type: "superseded"; readonly entry: BrainSchema.Entry; readonly previous: string }
  | { readonly type: "refused"; readonly reason: Refusal; readonly message: string }

export type Change = {
  readonly text?: string
  readonly pinned?: boolean
  readonly action?: "approve" | "reject" | "archive" | "restore"
}

export type Filter = "active" | "review" | "archived" | "all"

export type Detail = {
  readonly entry: BrainSchema.Entry
  readonly evidence: readonly BrainSchema.Evidence[]
  readonly related: readonly BrainSchema.Entry[]
}

export type Injection = { readonly text?: string; readonly ids: readonly string[]; readonly tokens: number }

export type Stats = {
  readonly active: number
  readonly review: number
  readonly archived: number
  readonly rules: number
  readonly learned: number
  readonly digestTokens: number
  readonly learning: boolean
}

export type Consolidation = {
  readonly skipped: boolean
  readonly merged: number
  readonly promoted: number
  readonly archived: number
  readonly dropped: number
  readonly stale: number
}

export interface Interface {
  readonly sync: (place: Place) => Effect.Effect<void>
  readonly digest: (place: Place, options: { readonly personal: boolean; readonly index: boolean }) => Effect.Effect<Injection>
  readonly recall: (
    place: Place,
    input: {
      readonly query: string
      readonly files?: readonly string[]
      readonly budget: number
      readonly personal: boolean
      readonly exclude?: ReadonlySet<string>
      readonly sessionID?: string
    },
  ) => Effect.Effect<Injection>
  readonly attach: (
    place: Place,
    input: {
      readonly file: string
      readonly personal: boolean
      readonly exclude?: ReadonlySet<string>
      readonly sessionID?: string
    },
  ) => Effect.Effect<Injection>
  readonly search: (
    place: Place,
    input: { readonly query: string; readonly personal: boolean; readonly limit?: number; readonly sessionID?: string },
  ) => Effect.Effect<BrainSchema.Entry[]>
  readonly get: (place: Place, id: string, options: { readonly personal: boolean }) => Effect.Effect<Detail | undefined>
  readonly list: (
    place: Place,
    input: { readonly filter?: Filter; readonly query?: string; readonly scope?: BrainSchema.Scope },
  ) => Effect.Effect<BrainSchema.Entry[]>
  readonly propose: (place: Place, proposal: Proposal) => Effect.Effect<WriteResult>
  readonly update: (
    place: Place,
    id: string,
    change: Change,
    actor: "user" | "agent",
  ) => Effect.Effect<WriteResult | undefined>
  readonly forget: (place: Place, id: string) => Effect.Effect<"forgotten" | "not-found" | "file-entry">
  readonly erase: (place: Place, scope: BrainSchema.Scope | "all") => Effect.Effect<number>
  readonly consolidate: (place: Place, options?: { readonly force?: boolean }) => Effect.Effect<Consolidation>
  readonly stats: (place: Place) => Effect.Effect<Stats>
  readonly learning: () => Effect.Effect<boolean>
  readonly setLearning: (enabled: boolean) => Effect.Effect<void>
  /** How many active entries this session made since `since`, for the per-message write cap. */
  readonly written: (sessionID: string, since: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Brain") {}

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type Database = Effect.Success<typeof makeDatabase>
type Row = typeof BrainEntryTable.$inferSelect

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const PERSONAL = ""
const LEARNED: readonly BrainSchema.Origin[] = ["agent", "user"]

export const layerFor = (input: { readonly file: string; readonly data?: string; readonly config?: string }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const data = input.data ?? global.data
      const config = input.config ?? global.config
      const db = yield* makeDatabase
      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA foreign_keys = ON")
      // Forgotten memory is overwritten on disk, not just unlinked from the b-tree.
      yield* db.run("PRAGMA secure_delete = ON")
      yield* DatabaseMigration.applyOnly(db, [first])
      if (input.file !== ":memory:" && process.platform !== "win32")
        yield* Effect.sync(() => chmodSync(input.file, 0o600)).pipe(Effect.ignore)
      return make(db, { data, config })
    }).pipe(Effect.orDie),
  ).pipe(
    Layer.provide(
      Layer.suspend(() => {
        if (input.file !== ":memory:") mkdirSync(path.dirname(input.file), { recursive: true, mode: 0o700 })
        return layer({ filename: input.file })
      }),
    ),
  )

/**
 * brain.db beside vector.db: latest, beta and prod share one; a development channel gets its own, so a dev build never
 * touches real memory. A session database in memory (tests, the onboarding check) means a brain in memory too.
 */
export function databasePath() {
  if (Flag.VECTOR_AGENT_DB === ":memory:") return ":memory:"
  const channel =
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.VECTOR_DISABLE_CHANNEL_DB === "1" ||
    process.env.VECTOR_DISABLE_CHANNEL_DB === "true"
  return path.join(
    BrainPaths.directory(Global.Path.data),
    channel ? "brain.db" : `brain-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`,
  )
}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.suspend(() => layerFor({ file: databasePath() })),
  deps: [Global.node],
})

function make(db: Database, dirs: { readonly data: string; readonly config: string }): Interface {
  const personalFiles = {
    memory: path.join(dirs.config, "MEMORY.md"),
    rules: path.join(dirs.config, "RULES.md"),
  }
  const failureFile = (place: Place) => BrainPaths.failureFile(dirs.data, place.root)
  const repositoryFiles = (place: Place) => [...place.sources.map((source) => source.path), failureFile(place)]

  // What one place may see: its repository's learned entries and the mirrors of its own working tree's files (another
  // worktree's RULES.md may differ), plus the user's own rules always and their personal memory when allowed.
  const visible = (place: Place, personal: boolean) =>
    or(
      and(
        eq(BrainEntryTable.repository_id, place.repository),
        or(isNull(BrainEntryTable.source_file), inArray(BrainEntryTable.source_file, repositoryFiles(place))),
      ),
      personal
        ? eq(BrainEntryTable.repository_id, PERSONAL)
        : and(eq(BrainEntryTable.repository_id, PERSONAL), eq(BrainEntryTable.kind, "rule")),
    )

  const bump = (repository: string) =>
    db
      .insert(BrainStateTable)
      .values({ repository_id: repository, revision: 1 })
      .onConflictDoUpdate({
        target: BrainStateTable.repository_id,
        set: { revision: sql`${BrainStateTable.revision} + 1` },
      })
      .run()
      .pipe(Effect.orDie)

  const event = (row: Pick<Row, "id" | "repository_id">, action: string, actor: "user" | "agent" | "vector", detail?: Record<string, unknown>) =>
    db
      .insert(BrainEventTable)
      .values({ entry_id: row.id, repository_id: row.repository_id, at: Date.now(), action, actor, detail })
      .run()
      .pipe(Effect.orDie)

  // --- Mirrors of files -------------------------------------------------------------------------------------------

  type Mirror = {
    readonly path: string
    readonly repository: string
    readonly scope: BrainSchema.Scope
    readonly type: "rules" | "memory" | "brain" | "failures"
    readonly held: boolean
  }

  const mirrors = (place: Place): Mirror[] => [
    { path: personalFiles.rules, repository: PERSONAL, scope: "personal", type: "rules", held: false },
    { path: personalFiles.memory, repository: PERSONAL, scope: "personal", type: "memory", held: false },
    ...place.sources.map((source) => ({
      path: source.path,
      repository: place.repository,
      scope: "repository" as const,
      type: source.type,
      // A repository's own rules load as its instructions do. Memory it ships is held until the repository is trusted.
      held: source.type === "brain" && place.held,
    })),
    { path: failureFile(place), repository: place.repository, scope: "repository", type: "failures", held: false },
  ]

  const mirror = Effect.fnUntraced(function* (source: Mirror) {
    const stat = yield* Effect.promise(() => fs.lstat(source.path).catch(() => undefined))
    const known = yield* db
      .select()
      .from(BrainSourceTable)
      .where(eq(BrainSourceTable.path, source.path))
      .get()
      .pipe(Effect.orDie)
    if (!stat || !stat.isFile()) {
      if (!known) return
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.delete(BrainEntryTable).where(eq(BrainEntryTable.source_file, source.path)).run()
          yield* tx.delete(BrainSourceTable).where(eq(BrainSourceTable.path, source.path)).run()
        }),
      ).pipe(Effect.orDie)
      return yield* bump(source.repository)
    }
    const mtime = Math.round(stat.mtimeMs)
    if (known && known.size === stat.size && known.mtime === mtime && known.held === source.held) return
    const content = yield* Effect.promise(() =>
      fs
        .open(source.path, "r")
        .then(async (handle) => {
          const buffer = Buffer.alloc(Math.min(stat.size, LIMIT.file))
          await handle.read(buffer, 0, buffer.length, 0).finally(() => handle.close())
          return buffer.toString("utf8")
        })
        .catch(() => ""),
    )
    const hash = createHash("sha256").update(content).digest("hex")
    if (known && known.content_hash === hash && known.held === source.held) {
      yield* db
        .update(BrainSourceTable)
        .set({ size: stat.size, mtime, synced_at: Date.now() })
        .where(eq(BrainSourceTable.path, source.path))
        .run()
        .pipe(Effect.orDie)
      return
    }
    const items = parse(source, content)
    const existing = new Map(
      (yield* db
        .select()
        .from(BrainEntryTable)
        .where(eq(BrainEntryTable.source_file, source.path))
        .all()
        .pipe(Effect.orDie)).map((row) => [row.id, row]),
    )
    const now = Date.now()
    const rows = dedupe(items).map((item) => {
      const id = fileId(source.path, item.signature ?? item.text)
      const previous = existing.get(id)
      const hold = itemHold(source, item)
      // The same text keeps the same id, so a person's approval of an instruction-like line survives later reads.
      const approved = previous?.status === "active" && previous.hold_reason === null && hold === "instruction-like"
      const status: BrainSchema.Status = hold && !approved ? "quarantined" : "active"
      return {
        id,
        scope: source.scope,
        repository_id: source.repository,
        kind: item.kind,
        origin: source.type === "failures" ? ("failure-memory" as const) : ("file" as const),
        status,
        pinned: previous?.pinned ?? false,
        body: BrainScan.stripHidden(item.text),
        paths: [...item.paths],
        terms: encode(BrainLexical.terms([item.heading ?? "", item.text, ...item.paths].join(" "))),
        norm_hash: normHash(item.text),
        confidence: 1,
        uses: previous?.uses ?? 0,
        helpful: previous?.helpful ?? 0,
        harmful: previous?.harmful ?? 0,
        last_used_at: previous?.last_used_at ?? null,
        created_at: previous?.created_at ?? now,
        updated_at: previous && previous.body === item.text ? previous.updated_at : now,
        superseded_by: null,
        stale: false,
        hold_reason: status === "quarantined" ? hold! : null,
        related: [],
        tier0: false,
        source_file: source.path,
        source_line: item.line,
        origin_session_id: null,
        signature: item.signature ?? null,
      } satisfies Row
    })
    const digest = render(source, content, rows)
    const tier0 = new Set(digest?.ids ?? [])
    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          for (const row of rows) {
            const value = { ...row, tier0: tier0.has(row.id) }
            yield* tx
              .insert(BrainEntryTable)
              .values(value)
              .onConflictDoUpdate({ target: BrainEntryTable.id, set: value })
              .run()
          }
          yield* tx
            .delete(BrainEntryTable)
            .where(
              rows.length
                ? and(eq(BrainEntryTable.source_file, source.path), notInArray(BrainEntryTable.id, rows.map((row) => row.id)))
                : eq(BrainEntryTable.source_file, source.path),
            )
            .run()
          const record = {
            path: source.path,
            repository_id: source.repository,
            content_hash: hash,
            size: stat.size,
            mtime,
            held: source.held,
            digest: digest?.text ?? null,
            synced_at: now,
          }
          yield* tx
            .insert(BrainSourceTable)
            .values(record)
            .onConflictDoUpdate({ target: BrainSourceTable.path, set: record })
            .run()
        }),
      )
      .pipe(Effect.orDie)
    yield* bump(source.repository)
  })

  const sync = Effect.fn("Brain.sync")(function* (place: Place) {
    yield* Effect.forEach(mirrors(place), mirror, { discard: true })
  })

  // --- Reading ----------------------------------------------------------------------------------------------------

  const visibleRows = Effect.fnUntraced(function* (place: Place, personal: boolean, statuses: readonly BrainSchema.Status[]) {
    return yield* db
      .select()
      .from(BrainEntryTable)
      .where(and(visible(place, personal), inArray(BrainEntryTable.status, [...statuses])))
      .all()
      .pipe(Effect.orDie)
  })

  const used = Effect.fnUntraced(function* (
    ids: readonly string[],
    sessionID: string | undefined,
    tier: "digest" | "recall" | "attach" | "search",
    tokens: number,
  ) {
    if (ids.length === 0) return
    const now = Date.now()
    yield* db
      .update(BrainEntryTable)
      .set({ uses: sql`${BrainEntryTable.uses} + 1`, last_used_at: now })
      .where(inArray(BrainEntryTable.id, [...ids]))
      .run()
      .pipe(Effect.orDie)
    if (!sessionID) return
    yield* db
      .insert(BrainUseTable)
      .values(ids.map((id) => ({ session_id: sessionID, entry_id: id, tier, tokens: Math.round(tokens / ids.length), at: now })))
      .run()
      .pipe(Effect.orDie)
  })

  const digest = Effect.fn("Brain.digest")(function* (place: Place, options: { personal: boolean; index: boolean }) {
    yield* sync(place)
    const paths = [
      personalFiles.rules,
      ...place.sources.filter((source) => source.type === "rules").map((source) => source.path),
      ...(options.personal ? [personalFiles.memory] : []),
    ]
    const sources = new Map(
      (yield* db.select().from(BrainSourceTable).where(inArray(BrainSourceTable.path, paths)).all().pipe(Effect.orDie)).map(
        (row) => [row.path, row],
      ),
    )
    const rows = yield* visibleRows(place, options.personal, ["active"])
    const pinned = rows
      .filter((row) => row.pinned && !row.tier0 && row.kind !== "review" && !row.stale)
      .toSorted((a, b) => a.created_at - b.created_at)
      .reduce<Row[]>((kept, row) => (tokensOf(kept) + Token.estimate(line(row)) > BUDGET.pinned ? kept : [...kept, row]), [])
    const shown = new Set([...rows.filter((row) => row.tier0).map((row) => row.id), ...pinned.map((row) => row.id)])
    const rest = rows.filter((row) => !shown.has(row.id) && row.kind !== "review" && row.kind !== "rule")
    const rules = paths
      .filter((file) => file !== personalFiles.memory)
      .flatMap((file) => {
        const text = sources.get(file)?.digest
        if (!text) return []
        return [`${file === personalFiles.rules ? "Your rules (RULES.md in your Vector settings)" : `Repository rules (${label(place, file)})`}:\n${text}`]
      })
    const memory = sources.get(personalFiles.memory)?.digest
    const advisory = Boolean(memory || pinned.length || rest.length)
    const sections = [
      ...rules,
      ...(memory ? [`What the user told you about themselves (MEMORY.md):\n${memory}`] : []),
      ...(pinned.length ? [`Pinned memory:\n${pinned.map(line).join("\n")}`] : []),
      ...(options.index && rest.length
        ? [
            `Vector also remembers ${rest.length} note${rest.length === 1 ? "" : "s"} about this work (lessons, decisions, facts, past failures); the memory tool searches them.`,
          ]
        : []),
    ]
    if (sections.length === 0) return { ids: [], tokens: 0 }
    const text = [
      "<vector_memory>",
      rules.length ? "Rules bind unless the user says otherwise now." : undefined,
      advisory ? "Memory is advisory: the current code and what the user says now win over it." : undefined,
      sections.join("\n\n"),
      "</vector_memory>",
    ]
      .filter((part): part is string => part !== undefined)
      .join("\n")
    return { text, ids: [...shown], tokens: Token.estimate(text) }
  })

  const candidates = Effect.fnUntraced(function* (place: Place, personal: boolean, exclude: ReadonlySet<string>) {
    return (yield* visibleRows(place, personal, ["active"])).filter(
      (row) => !row.tier0 && !row.pinned && !row.stale && row.kind !== "review" && !exclude.has(row.id),
    )
  })

  const recall = Effect.fn("Brain.recall")(function* (
    place: Place,
    input: {
      query: string
      files?: readonly string[]
      budget: number
      personal: boolean
      exclude?: ReadonlySet<string>
      sessionID?: string
    },
  ) {
    if (input.budget <= 0) return { ids: [], tokens: 0 }
    yield* sync(place)
    const rows = yield* candidates(place, input.personal, input.exclude ?? new Set())
    const files = (input.files ?? []).map(relative(place))
    const query = BrainLexical.terms([input.query, ...files].join(" "))
    const now = Date.now()
    const ranked = BrainLexical.rank(
      rows.map((row) => ({ id: row.id, terms: decode(row.terms) })),
      query,
    )
    const scored = new Map(ranked.map((item) => [item.id, item]))
    const picked = rows
      .flatMap((row) => {
        const lexical = scored.get(row.id)
        const pathHit = row.paths.length > 0 && files.some((file) => row.paths.some((pattern) => matches(pattern, file)))
        // One shared word is noise in a long request; two, or the only word of a short one, is a topic.
        const relevant = pathHit || (lexical !== undefined && (lexical.matched.length >= 2 || (query.size <= 2 && lexical.matched.length >= 1)))
        if (!relevant) return []
        const recency = Math.max(0.5, 0.995 ** ((now - (row.last_used_at ?? row.updated_at)) / HOUR))
        return [{ row, score: ((lexical?.score ?? 0) + (pathHit ? 5 : 0)) * row.confidence * recency }]
      })
      .toSorted((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id))
      .slice(0, 5)
      .reduce<Row[]>(
        (kept, item) =>
          tokensOf([...kept, item.row]) + 30 > input.budget ? kept : [...kept, item.row],
        [],
      )
    if (picked.length === 0) return { ids: [], tokens: 0 }
    const text = [
      "<vector_memory_recall>",
      "Memory that may bear on this request. Rules bind; the rest is advisory, so check it against the code:",
      ...picked.map(line),
      "</vector_memory_recall>",
    ].join("\n")
    const tokens = Token.estimate(text)
    yield* used(
      picked.map((row) => row.id),
      input.sessionID,
      "recall",
      tokens,
    )
    return { text, ids: picked.map((row) => row.id), tokens }
  })

  const attach = Effect.fn("Brain.attach")(function* (
    place: Place,
    input: { file: string; personal: boolean; exclude?: ReadonlySet<string>; sessionID?: string },
  ) {
    const file = relative(place)(input.file)
    if (file.startsWith("../")) return { ids: [], tokens: 0 }
    yield* sync(place)
    const rows = (yield* candidates(place, input.personal, input.exclude ?? new Set())).filter(
      (row) => row.paths.length > 0 && row.paths.some((pattern) => matches(pattern, file)),
    )
    const picked = rows
      .toSorted((a, b) => Number(b.kind === "rule") - Number(a.kind === "rule") || a.id.localeCompare(b.id))
      .reduce<Row[]>((kept, row) => (tokensOf([...kept, row]) > BUDGET.attach ? kept : [...kept, row]), [])
    if (picked.length === 0) return { ids: [], tokens: 0 }
    const text = [`Vector's memory for ${file} (rules bind; the rest is advisory):`, ...picked.map(line)].join("\n")
    const tokens = Token.estimate(text)
    yield* used(
      picked.map((row) => row.id),
      input.sessionID,
      "attach",
      tokens,
    )
    return { text, ids: picked.map((row) => row.id), tokens }
  })

  const search = Effect.fn("Brain.search")(function* (
    place: Place,
    input: { query: string; personal: boolean; limit?: number; sessionID?: string },
  ) {
    yield* sync(place)
    const rows = (yield* visibleRows(place, input.personal, ["active"])).filter((row) => row.kind !== "review")
    const query = BrainLexical.terms(input.query)
    const ranked = query.size
      ? BrainLexical.rank(
          rows.map((row) => ({ id: row.id, terms: decode(row.terms) })),
          query,
        ).flatMap((item) => rows.filter((row) => row.id === item.id))
      : rows.toSorted((a, b) => (b.last_used_at ?? b.updated_at) - (a.last_used_at ?? a.updated_at))
    const picked = ranked
      .slice(0, input.limit ?? 5)
      .reduce<Row[]>((kept, row) => (kept.map(line).join("\n").length + line(row).length > BUDGET.search && kept.length ? kept : [...kept, row]), [])
    yield* used(
      picked.map((row) => row.id),
      input.sessionID,
      "search",
      Token.estimate(picked.map(line).join("\n")),
    )
    return picked.map(toEntry)
  })

  const find = Effect.fnUntraced(function* (place: Place, id: string, personal: boolean) {
    return yield* db
      .select()
      .from(BrainEntryTable)
      .where(and(eq(BrainEntryTable.id, id), visible(place, personal)))
      .get()
      .pipe(Effect.orDie)
  })

  const get = Effect.fn("Brain.get")(function* (place: Place, id: string, options: { personal: boolean }) {
    const row = yield* find(place, id, options.personal)
    if (!row) return undefined
    const evidence = yield* db
      .select()
      .from(BrainEvidenceTable)
      .where(eq(BrainEvidenceTable.entry_id, id))
      .orderBy(asc(BrainEvidenceTable.created_at))
      .all()
      .pipe(Effect.orDie)
    const related = row.related.length
      ? yield* db
          .select()
          .from(BrainEntryTable)
          .where(and(inArray(BrainEntryTable.id, row.related), visible(place, options.personal), eq(BrainEntryTable.status, "active")))
          .all()
          .pipe(Effect.orDie)
      : []
    return {
      entry: toEntry(row),
      evidence: evidence.map((item) => ({
        type: item.type,
        ...(item.path ? { path: item.path } : {}),
        ...(item.quote ? { quote: item.quote } : {}),
        ...(item.command ? { command: item.command } : {}),
        ...(item.session_id ? { sessionID: item.session_id } : {}),
        createdAt: item.created_at,
      })),
      related: related.map(toEntry),
    }
  })

  const list = Effect.fn("Brain.list")(function* (
    place: Place,
    input: { filter?: Filter; query?: string; scope?: BrainSchema.Scope },
  ) {
    yield* sync(place)
    const statuses: readonly BrainSchema.Status[] =
      input.filter === "review"
        ? ["proposed", "quarantined"]
        : input.filter === "archived"
          ? ["archived", "superseded"]
          : input.filter === "all"
            ? ["active", "proposed", "quarantined", "archived", "superseded"]
            : ["active"]
    const rows = (yield* visibleRows(place, true, statuses)).filter(
      (row) => !input.scope || row.scope === input.scope,
    )
    const query = input.query?.trim().toLowerCase()
    if (!query) return rows.toSorted(byPlace).map(toEntry)
    const terms = BrainLexical.terms(query)
    const ranked = new Map(
      BrainLexical.rank(
        rows.map((row) => ({ id: row.id, terms: decode(row.terms) })),
        terms,
      ).map((item, index) => [item.id, index]),
    )
    return rows
      .filter((row) => ranked.has(row.id) || row.body.toLowerCase().includes(query) || row.id === query)
      .toSorted((a, b) => (ranked.get(a.id) ?? 1e9) - (ranked.get(b.id) ?? 1e9) || byPlace(a, b))
      .map(toEntry)
  })

  // --- Writing ----------------------------------------------------------------------------------------------------

  const learning = Effect.fn("Brain.learning")(function* () {
    const row = yield* db
      .select()
      .from(BrainStateTable)
      .where(eq(BrainStateTable.repository_id, PERSONAL))
      .get()
      .pipe(Effect.orDie)
    return row?.learning ?? true
  })

  const setLearning = Effect.fn("Brain.setLearning")(function* (enabled: boolean) {
    yield* db
      .insert(BrainStateTable)
      .values({ repository_id: PERSONAL, learning: enabled })
      .onConflictDoUpdate({ target: BrainStateTable.repository_id, set: { learning: enabled } })
      .run()
      .pipe(Effect.orDie)
  })

  const written = Effect.fn("Brain.written")(function* (sessionID: string, since: number) {
    const rows = yield* db
      .select({ id: BrainEntryTable.id })
      .from(BrainEntryTable)
      .where(
        and(
          eq(BrainEntryTable.origin_session_id, sessionID),
          eq(BrainEntryTable.status, "active"),
          sql`${BrainEntryTable.created_at} >= ${since}`,
        ),
      )
      .all()
      .pipe(Effect.orDie)
    return rows.length
  })

  const evidenceRow = (entry: string, evidence: Evidence | undefined, sessionID: string | undefined) => {
    const now = Date.now()
    if (!evidence || evidence.type === "user") return { entry_id: entry, type: "user" as const, session_id: sessionID ?? null, created_at: now }
    if (evidence.type === "message")
      return { entry_id: entry, type: "message" as const, quote: evidence.quote.slice(0, 240), session_id: sessionID ?? null, created_at: now }
    if (evidence.type === "file")
      return {
        entry_id: entry,
        type: "file" as const,
        path: evidence.path,
        quote: evidence.quote.slice(0, 240),
        file_hash: evidence.hash ?? null,
        session_id: sessionID ?? null,
        created_at: now,
      }
    return { entry_id: entry, type: "check" as const, command: evidence.command.slice(0, 240), session_id: sessionID ?? null, created_at: now }
  }

  const tombstoned = Effect.fnUntraced(function* (repository: string, hash: string) {
    const row = yield* db
      .select()
      .from(BrainTombstoneTable)
      .where(and(eq(BrainTombstoneTable.repository_id, repository), eq(BrainTombstoneTable.norm_hash, hash)))
      .get()
      .pipe(Effect.orDie)
    return row !== undefined && row.until > Date.now()
  })

  const propose = Effect.fn("Brain.propose")(function* (place: Place, proposal: Proposal) {
    if (proposal.origin === "agent" && !(yield* learning()))
      return refuse("learning-off", "Learning is turned off in Settings > Memory, so nothing was saved.")
    const hiddenText = BrainScan.hidden(proposal.text)
    const cleaned = BrainScan.stripHidden(proposal.text).replace(/\s+/g, " ").trim()
    if (!cleaned) return refuse("empty", "Nothing to save.")
    const limit = proposal.origin === "agent" ? LIMIT.agent : LIMIT.user
    if (cleaned.length > limit)
      return refuse("too-long", `Keep one memory to ${limit} characters: one fact, lesson or decision per entry.`)
    const redacted = BrainScan.redact(cleaned)
    if (redacted.redacted && BrainScan.remainder(redacted.text) < 16)
      return refuse("secret", "That is a secret. Memory never stores secrets, keys, tokens or passwords.")
    const text = redacted.text
    // Personal memory follows the user into every repository, so only what the user said about themselves goes there.
    const evidence = proposal.evidence
    const verified = proposal.origin === "user" || (evidence !== undefined && evidence.type !== "user" && evidence.verified)
    const scope: BrainSchema.Scope =
      proposal.scope === "personal" &&
      (proposal.origin === "user" || (evidence?.type === "message" && evidence.verified))
        ? "personal"
        : "repository"
    const repository = scope === "personal" ? PERSONAL : place.repository
    const hash = normHash(text)
    if (proposal.origin === "agent" && (yield* tombstoned(repository, hash)))
      return refuse("forgotten", "The user asked Vector to forget this, so it was not saved again.")
    const hold =
      proposal.origin === "user"
        ? undefined
        : (proposal.hold ?? (hiddenText ? "hidden-unicode" : BrainScan.instructionLike(text) ? "instruction-like" : undefined))
    const previous = proposal.supersedes ? yield* find(place, proposal.supersedes, true) : undefined
    if (proposal.supersedes && !previous) return refuse("not-found", `No memory ${proposal.supersedes} here.`)
    if (previous && !LEARNED.includes(previous.origin))
      return refuse(
        "file-entry",
        `${previous.id} comes from ${previous.source_file ? path.basename(previous.source_file) : "a file"}; ask the user to edit that file.`,
      )

    const peers = yield* db
      .select()
      .from(BrainEntryTable)
      .where(
        and(
          eq(BrainEntryTable.repository_id, repository),
          inArray(BrainEntryTable.origin, [...LEARNED]),
          inArray(BrainEntryTable.status, ["active", "proposed", "quarantined", "archived"]),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const own = BrainLexical.terms([text, ...(proposal.paths ?? [])].join(" "))
    const same =
      peers.find((row) => row.norm_hash === hash) ??
      (previous
        ? undefined
        : peers.find(
            (row) =>
              row.kind === proposal.kind && row.status !== "archived" && BrainLexical.similarity(decode(row.terms), own) >= 0.72,
          ))
    const now = Date.now()
    if (same && same.id !== previous?.id) {
      // Writing what is already known adds its evidence, and a second session that learns a proposal confirms it.
      const confirms =
        same.status === "proposed" &&
        !hold &&
        (verified || (proposal.sessionID !== undefined && same.origin_session_id !== proposal.sessionID))
      const restores = same.status === "archived" && !hold && verified
      const status = confirms || restores ? "active" : same.status
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .update(BrainEntryTable)
            .set({
              status,
              confidence: Math.max(same.confidence, confidence(proposal)),
              updated_at: now,
              paths: [...new Set([...same.paths, ...(proposal.paths ?? [])])],
            })
            .where(eq(BrainEntryTable.id, same.id))
            .run()
          yield* tx.insert(BrainEvidenceTable).values(evidenceRow(same.id, evidence, proposal.sessionID)).run()
        }),
      ).pipe(Effect.orDie)
      yield* event(same, confirms ? "promoted" : "merged", proposal.origin)
      yield* bump(repository)
      const entry = toEntry({ ...same, status, updated_at: now })
      if (status === "quarantined") return { type: "held" as const, entry }
      if (status === "proposed") return { type: "proposed" as const, entry }
      return { type: confirms ? ("promoted" as const) : ("merged" as const), entry }
    }

    const cap = proposal.origin === "agent" && proposal.sessionID !== undefined && proposal.since !== undefined
      ? (yield* written(proposal.sessionID, proposal.since)) >= LIMIT.perMessage
      : false
    const status: BrainSchema.Status = hold ? "quarantined" : verified && !cap ? "active" : "proposed"
    const id = yield* freshId()
    const related = peers
      .filter((row) => row.status === "active")
      .map((row) => ({ id: row.id, score: BrainLexical.similarity(decode(row.terms), own) }))
      .filter((item) => item.score >= 0.2)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((item) => item.id)
    const row: Row = {
      id,
      scope,
      repository_id: repository,
      kind: proposal.kind,
      origin: proposal.origin,
      status,
      pinned: false,
      body: text,
      paths: [...(proposal.paths ?? [])],
      terms: encode(own),
      norm_hash: hash,
      confidence: confidence(proposal),
      uses: 0,
      helpful: 0,
      harmful: 0,
      last_used_at: null,
      created_at: now,
      updated_at: now,
      superseded_by: null,
      stale: false,
      hold_reason: hold ?? null,
      related,
      tier0: false,
      source_file: null,
      source_line: null,
      origin_session_id: proposal.sessionID ?? null,
      signature: null,
    }
    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(BrainEntryTable).values(row).run()
          yield* tx.insert(BrainEvidenceTable).values(evidenceRow(id, evidence, proposal.sessionID)).run()
          if (previous)
            yield* tx
              .update(BrainEntryTable)
              .set({ status: "superseded", superseded_by: id, updated_at: now })
              .where(eq(BrainEntryTable.id, previous.id))
              .run()
          if (proposal.origin === "user")
            yield* tx
              .delete(BrainTombstoneTable)
              .where(and(eq(BrainTombstoneTable.repository_id, repository), eq(BrainTombstoneTable.norm_hash, hash)))
              .run()
        }),
      )
      .pipe(Effect.orDie)
    yield* event(row, previous ? "superseded" : "added", proposal.origin, previous ? { previous: previous.id } : undefined)
    if (status === "active") yield* capacity(repository)
    yield* bump(repository)
    const entry = toEntry(row)
    if (status === "quarantined") return { type: "held" as const, entry }
    if (status === "proposed") return { type: "proposed" as const, entry }
    if (previous) return { type: "superseded" as const, entry, previous: previous.id }
    return { type: "added" as const, entry }
  })

  const freshId = Effect.fnUntraced(function* () {
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = `m${base32(randomBytes(4)).slice(0, 5)}`
      const taken = yield* db
        .select({ id: BrainEntryTable.id })
        .from(BrainEntryTable)
        .where(eq(BrainEntryTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!taken) return id
    }
    return `m${base32(randomBytes(8))}`
  })

  // Past the cap, the least useful learned entry goes to the archive: never used, then least recently.
  const capacity = Effect.fnUntraced(function* (repository: string) {
    const rows = yield* db
      .select()
      .from(BrainEntryTable)
      .where(
        and(
          eq(BrainEntryTable.repository_id, repository),
          inArray(BrainEntryTable.origin, [...LEARNED]),
          eq(BrainEntryTable.status, "active"),
          eq(BrainEntryTable.pinned, false),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const cap = repository === PERSONAL ? LIMIT.personal : LIMIT.repository
    const excess = rows
      .toSorted((a, b) => a.uses - b.uses || (a.last_used_at ?? a.created_at) - (b.last_used_at ?? b.created_at))
      .slice(0, Math.max(0, rows.length - cap))
    if (excess.length === 0) return 0
    yield* db
      .update(BrainEntryTable)
      .set({ status: "archived", updated_at: Date.now() })
      .where(inArray(BrainEntryTable.id, excess.map((row) => row.id)))
      .run()
      .pipe(Effect.orDie)
    return excess.length
  })

  const update = Effect.fn("Brain.update")(function* (place: Place, id: string, change: Change, actor: "user" | "agent") {
    const row = yield* find(place, id, true)
    if (!row) return undefined
    const learned = LEARNED.includes(row.origin)
    const now = Date.now()
    if (change.text !== undefined) {
      if (!learned) return refuse("file-entry", `${row.id} comes from ${row.source_file ? path.basename(row.source_file) : "a file"}; edit that file.`)
      const cleaned = BrainScan.stripHidden(change.text).replace(/\s+/g, " ").trim()
      if (!cleaned) return refuse("empty", "Nothing to save.")
      if (cleaned.length > LIMIT.user) return refuse("too-long", `Keep one memory to ${LIMIT.user} characters.`)
      const redacted = BrainScan.redact(cleaned)
      if (redacted.redacted && BrainScan.remainder(redacted.text) < 16)
        return refuse("secret", "That is a secret. Memory never stores secrets, keys, tokens or passwords.")
      yield* db
        .update(BrainEntryTable)
        .set({
          body: redacted.text,
          terms: encode(BrainLexical.terms([redacted.text, ...row.paths].join(" "))),
          norm_hash: normHash(redacted.text),
          confidence: actor === "user" ? 1 : row.confidence,
          stale: false,
          updated_at: now,
        })
        .where(eq(BrainEntryTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* event(row, "edited", actor, { previous: row.body })
    }
    if (change.pinned !== undefined) {
      yield* db.update(BrainEntryTable).set({ pinned: change.pinned }).where(eq(BrainEntryTable.id, id)).run().pipe(Effect.orDie)
      yield* event(row, change.pinned ? "pinned" : "unpinned", actor)
    }
    if (change.action === "approve" && (row.status === "proposed" || row.status === "quarantined")) {
      // A repository's own memory waits on trusting the repository, and a hidden character on fixing the file.
      if (!learned && row.hold_reason !== "instruction-like")
        return refuse(
          "file-entry",
          row.hold_reason === "untrusted-repository"
            ? "Trust this repository in Settings to use the memory it ships."
            : `Remove the hidden characters from ${row.source_file ? path.basename(row.source_file) : "the file"}.`,
        )
      yield* db
        .update(BrainEntryTable)
        .set({ status: "active", hold_reason: null, confidence: Math.max(row.confidence, 0.9), updated_at: now })
        .where(eq(BrainEntryTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* event(row, "approved", actor)
    }
    if (change.action === "reject" && (row.status === "proposed" || row.status === "quarantined")) {
      if (!learned) return refuse("file-entry", "This comes from a file; edit the file to change it.")
      yield* forgetRow(row)
      return { type: "merged" as const, entry: toEntry({ ...row, status: "archived" }) }
    }
    if (change.action === "archive" && learned && row.status === "active") {
      yield* db.update(BrainEntryTable).set({ status: "archived", updated_at: now }).where(eq(BrainEntryTable.id, id)).run().pipe(Effect.orDie)
      yield* event(row, "archived", actor)
    }
    if (change.action === "restore" && learned && (row.status === "archived" || row.status === "superseded")) {
      yield* db
        .update(BrainEntryTable)
        .set({ status: "active", superseded_by: null, updated_at: now })
        .where(eq(BrainEntryTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* event(row, "restored", actor)
    }
    yield* bump(row.repository_id)
    const next = yield* find(place, id, true)
    return next ? { type: "merged" as const, entry: toEntry(next) } : undefined
  })

  // Forgetting is a real delete: the row and its evidence go, and only a hash of the text stays so it is not learned
  // again for 180 days.
  const forgetRow = Effect.fnUntraced(function* (row: Row) {
    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.delete(BrainEntryTable).where(eq(BrainEntryTable.id, row.id)).run()
          yield* tx
            .insert(BrainTombstoneTable)
            .values({ repository_id: row.repository_id, norm_hash: row.norm_hash, until: Date.now() + 180 * DAY })
            .onConflictDoUpdate({
              target: [BrainTombstoneTable.repository_id, BrainTombstoneTable.norm_hash],
              set: { until: Date.now() + 180 * DAY },
            })
            .run()
          yield* tx.delete(BrainUseTable).where(eq(BrainUseTable.entry_id, row.id)).run()
          yield* tx.delete(BrainEventTable).where(eq(BrainEventTable.entry_id, row.id)).run()
        }),
      )
      .pipe(Effect.orDie)
    yield* event(row, "forgotten", "user")
    yield* bump(row.repository_id)
  })

  const forget = Effect.fn("Brain.forget")(function* (place: Place, id: string) {
    const row = yield* find(place, id, true)
    if (!row) return "not-found" as const
    if (row.origin === "file") return "file-entry" as const
    if (row.origin === "failure-memory" && row.source_file && row.signature) {
      // Failure memory is Vector's own file, so forgetting a record removes it there.
      yield* Effect.promise(() => removeFailure(row.source_file!, row.signature!))
      yield* db
        .delete(BrainSourceTable)
        .where(eq(BrainSourceTable.path, row.source_file))
        .run()
        .pipe(Effect.orDie)
    }
    yield* forgetRow(row)
    return "forgotten" as const
  })

  const erase = Effect.fn("Brain.erase")(function* (place: Place, scope: BrainSchema.Scope | "all") {
    const repositories = scope === "personal" ? [PERSONAL] : scope === "repository" ? [place.repository] : undefined
    const where = and(
      inArray(BrainEntryTable.origin, [...LEARNED]),
      repositories ? inArray(BrainEntryTable.repository_id, repositories) : undefined,
    )
    const rows = yield* db.select({ id: BrainEntryTable.id }).from(BrainEntryTable).where(where).all().pipe(Effect.orDie)
    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.delete(BrainEntryTable).where(where).run()
          yield* tx
            .delete(BrainEventTable)
            .where(repositories ? inArray(BrainEventTable.repository_id, repositories) : undefined)
            .run()
          yield* tx
            .delete(BrainTombstoneTable)
            .where(repositories ? inArray(BrainTombstoneTable.repository_id, repositories) : undefined)
            .run()
          if (rows.length) yield* tx.delete(BrainUseTable).where(inArray(BrainUseTable.entry_id, rows.map((row) => row.id))).run()
        }),
      )
      .pipe(Effect.orDie)
    // What Vector learned in a repository includes its failure memory.
    if (scope !== "personal") {
      const files = scope === "all" ? [path.join(BrainPaths.directory(dirs.data), "failures")] : [failureFile(place)]
      yield* Effect.promise(() => Promise.all(files.map((file) => fs.rm(file, { recursive: true, force: true }))))
      yield* db
        .delete(BrainEntryTable)
        .where(
          scope === "all"
            ? eq(BrainEntryTable.origin, "failure-memory")
            : and(eq(BrainEntryTable.origin, "failure-memory"), eq(BrainEntryTable.source_file, failureFile(place))),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .delete(BrainSourceTable)
        .where(scope === "all" ? sql`${BrainSourceTable.path} LIKE ${"%" + path.sep + "failures" + path.sep + "%"}` : eq(BrainSourceTable.path, failureFile(place)))
        .run()
        .pipe(Effect.orDie)
    }
    if (scope === "all") yield* db.run("VACUUM").pipe(Effect.orDie)
    yield* bump(scope === "personal" ? PERSONAL : place.repository)
    return rows.length
  })

  // --- Tidying ----------------------------------------------------------------------------------------------------

  const consolidate = Effect.fn("Brain.consolidate")(function* (place: Place, options?: { force?: boolean }) {
    const state = yield* db
      .select()
      .from(BrainStateTable)
      .where(eq(BrainStateTable.repository_id, place.repository))
      .get()
      .pipe(Effect.orDie)
    const now = Date.now()
    if (!options?.force && state?.consolidated_at && now - state.consolidated_at < 6 * HOUR)
      return { skipped: true, merged: 0, promoted: 0, archived: 0, dropped: 0, stale: 0 }
    const counts = { merged: 0, promoted: 0, archived: 0, dropped: 0, stale: 0 }
    for (const repository of [place.repository, PERSONAL]) {
      const rows = yield* db
        .select()
        .from(BrainEntryTable)
        .where(
          and(
            eq(BrainEntryTable.repository_id, repository),
            inArray(BrainEntryTable.origin, [...LEARNED]),
            inArray(BrainEntryTable.status, ["active", "proposed"]),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      // 1. Near-duplicates merge into the older entry, which keeps its words; the newer one is linked, not deleted.
      const gone = new Set<string>()
      for (const [index, row] of rows.toSorted((a, b) => a.created_at - b.created_at).entries()) {
        if (gone.has(row.id)) continue
        for (const other of rows.toSorted((a, b) => a.created_at - b.created_at).slice(index + 1)) {
          if (gone.has(other.id) || other.kind !== row.kind || other.pinned) continue
          if (BrainLexical.similarity(decode(row.terms), decode(other.terms)) < 0.72) continue
          gone.add(other.id)
          counts.merged++
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .update(BrainEvidenceTable)
                  .set({ entry_id: row.id })
                  .where(eq(BrainEvidenceTable.entry_id, other.id))
                  .run()
                yield* tx
                  .update(BrainEntryTable)
                  .set({ status: "superseded", superseded_by: row.id, updated_at: now })
                  .where(eq(BrainEntryTable.id, other.id))
                  .run()
                yield* tx
                  .update(BrainEntryTable)
                  .set({
                    uses: row.uses + other.uses,
                    status: row.status === "active" || other.status === "active" ? "active" : "proposed",
                    paths: [...new Set([...row.paths, ...other.paths])],
                    updated_at: now,
                  })
                  .where(eq(BrainEntryTable.id, row.id))
                  .run()
              }),
            )
            .pipe(Effect.orDie)
          yield* event(other, "merged", "vector", { into: row.id })
        }
      }
      const kept = rows.filter((row) => !gone.has(row.id))
      for (const row of kept) {
        // 2. A proposal two sessions arrived at is confirmed; one nobody confirmed in 30 days is dropped.
        if (row.status === "proposed") {
          const sessions = yield* db
            .selectDistinct({ session: BrainEvidenceTable.session_id })
            .from(BrainEvidenceTable)
            .where(eq(BrainEvidenceTable.entry_id, row.id))
            .all()
            .pipe(Effect.orDie)
          if (sessions.filter((item) => item.session).length >= 2) {
            counts.promoted++
            yield* db.update(BrainEntryTable).set({ status: "active", updated_at: now }).where(eq(BrainEntryTable.id, row.id)).run().pipe(Effect.orDie)
            yield* event(row, "promoted", "vector")
            continue
          }
          if (now - row.created_at > 30 * DAY) {
            counts.dropped++
            yield* db.delete(BrainEntryTable).where(eq(BrainEntryTable.id, row.id)).run().pipe(Effect.orDie)
          }
          continue
        }
        // 3. Unused for 90 days, or more often harmful than helpful: archived, never deleted.
        if (!row.pinned && ((now - (row.last_used_at ?? row.created_at) > 90 * DAY && row.uses < 2) || row.harmful > row.helpful)) {
          counts.archived++
          yield* db.update(BrainEntryTable).set({ status: "archived", updated_at: now }).where(eq(BrainEntryTable.id, row.id)).run().pipe(Effect.orDie)
          yield* event(row, "archived", "vector")
        }
      }
      counts.archived += yield* capacity(repository)
    }
    // 4. An entry whose cited file changed so the quote is gone is stale: kept out of automatic tiers until re-checked.
    const cited = yield* db
      .select({ entry: BrainEvidenceTable.entry_id, path: BrainEvidenceTable.path, quote: BrainEvidenceTable.quote, stale: BrainEntryTable.stale })
      .from(BrainEvidenceTable)
      .innerJoin(BrainEntryTable, eq(BrainEntryTable.id, BrainEvidenceTable.entry_id))
      .where(
        and(
          eq(BrainEvidenceTable.type, "file"),
          eq(BrainEntryTable.repository_id, place.repository),
          eq(BrainEntryTable.status, "active"),
        ),
      )
      .limit(50)
      .all()
      .pipe(Effect.orDie)
    for (const item of cited) {
      if (!item.path || !item.quote) continue
      const target = path.resolve(place.root, item.path)
      const content = yield* Effect.promise(() => fs.readFile(target, "utf8").catch(() => undefined))
      const stale = content === undefined || !normalise(content).includes(normalise(item.quote))
      if (stale === item.stale) continue
      if (stale) counts.stale++
      yield* db.update(BrainEntryTable).set({ stale }).where(eq(BrainEntryTable.id, item.entry)).run().pipe(Effect.orDie)
    }
    // 5. Old links, history and tombstones go.
    yield* db
      .delete(BrainEntryTable)
      .where(
        and(
          eq(BrainEntryTable.repository_id, place.repository),
          eq(BrainEntryTable.status, "superseded"),
          lt(BrainEntryTable.updated_at, now - 180 * DAY),
        ),
      )
      .run()
      .pipe(Effect.orDie)
    yield* db.delete(BrainTombstoneTable).where(lt(BrainTombstoneTable.until, now)).run().pipe(Effect.orDie)
    yield* db.delete(BrainUseTable).where(lt(BrainUseTable.at, now - 30 * DAY)).run().pipe(Effect.orDie)
    yield* db
      .insert(BrainStateTable)
      .values({ repository_id: place.repository, consolidated_at: now })
      .onConflictDoUpdate({ target: BrainStateTable.repository_id, set: { consolidated_at: now } })
      .run()
      .pipe(Effect.orDie)
    if (counts.merged + counts.promoted + counts.archived + counts.dropped + counts.stale > 0) {
      yield* bump(place.repository)
      yield* bump(PERSONAL)
    }
    return { skipped: false, ...counts }
  })

  const stats = Effect.fn("Brain.stats")(function* (place: Place) {
    const rows = yield* db
      .select({ status: BrainEntryTable.status, kind: BrainEntryTable.kind, origin: BrainEntryTable.origin })
      .from(BrainEntryTable)
      .where(visible(place, true))
      .all()
      .pipe(Effect.orDie)
    const shown = yield* digest(place, { personal: true, index: true })
    return {
      active: rows.filter((row) => row.status === "active").length,
      review: rows.filter((row) => row.status === "proposed" || row.status === "quarantined").length,
      archived: rows.filter((row) => row.status === "archived" || row.status === "superseded").length,
      rules: rows.filter((row) => row.kind === "rule" && row.status === "active").length,
      learned: rows.filter((row) => LEARNED.includes(row.origin) && row.status === "active").length,
      digestTokens: shown.tokens,
      learning: yield* learning(),
    }
  })

  return {
    sync,
    digest,
    recall,
    attach,
    search,
    get,
    list,
    propose,
    update,
    forget,
    erase,
    consolidate,
    stats,
    learning,
    setLearning,
    written,
  }
}

// --- Helpers --------------------------------------------------------------------------------------------------------

function parse(source: { readonly type: "rules" | "memory" | "brain" | "failures" }, content: string) {
  if (source.type === "rules") return BrainParse.rules(content)
  if (source.type === "memory") return BrainParse.memory(content)
  if (source.type === "brain") return BrainParse.brain(content)
  return BrainParse.failures(content)
}

function itemHold(source: { readonly type: string; readonly held: boolean }, item: BrainParse.Item): BrainSchema.Hold | undefined {
  if (BrainScan.hidden(item.text)) return "hidden-unicode"
  if (source.held) return "untrusted-repository"
  // A person's own rules and MEMORY.md are instructions by design; memory a repository ships or Vector recorded is not.
  if ((source.type === "brain" || source.type === "failures") && BrainScan.instructionLike(item.text)) return "instruction-like"
  return undefined
}

function dedupe(items: readonly BrainParse.Item[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = item.signature ?? normHash(item.text)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Rules and MEMORY.md as they go in the cached prefix, and which of their items that covers.
function render(
  source: { readonly type: "rules" | "memory" | "brain" | "failures" },
  content: string,
  rows: readonly Row[],
): { text?: string; ids: string[] } | undefined {
  const byLine = new Map(rows.map((row) => [row.source_line, row]))
  if (source.type === "rules") {
    const omit = (item: BrainParse.Item) => {
      const row = byLine.get(item.line)
      return item.kind === "review" || item.paths.length > 0 || row?.status !== "active"
    }
    const text = BrainParse.rulesText(BrainScan.stripHidden(content), omit)
    return {
      ...(text ? { text } : {}),
      ids: rows.filter((row) => row.status === "active" && row.kind === "rule" && row.paths.length === 0).map((row) => row.id),
    }
  }
  if (source.type !== "memory") return undefined
  const active = rows.filter((row) => row.status === "active")
  const whole = BrainParse.memoryText(content)
  if (active.length === rows.length && Token.estimate(whole) <= BUDGET.memory)
    return { ...(whole ? { text: whole } : {}), ids: active.map((row) => row.id) }
  // Past its budget, MEMORY.md goes in file order until the budget is spent; the rest is recalled when relevant.
  const kept = active.reduce<Row[]>(
    (list, row) => (Token.estimate([...list, row].map((item) => `- ${item.body}`).join("\n")) > BUDGET.memory - 40 ? list : [...list, row]),
    [],
  )
  const more = active.length - kept.length
  const text = [
    ...kept.map((row) => `- ${row.body}`),
    ...(more > 0 ? [`(${more} more saved item${more === 1 ? " is" : "s are"} recalled when relevant.)`] : []),
  ].join("\n")
  return { ...(text ? { text } : {}), ids: kept.map((row) => row.id) }
}

function label(place: Place, file: string) {
  const relativePath = path.relative(place.root, file)
  return relativePath && !relativePath.startsWith("..") ? relativePath.split(path.sep).join("/") : file
}

function relative(place: Place) {
  return (file: string) => {
    const resolved = path.isAbsolute(file) ? path.relative(place.root, file) : file
    return resolved.split(path.sep).join("/").replace(/^\.\//, "")
  }
}

/** A file pattern from a rule or entry: a glob, or a bare directory that covers everything under it. */
export function matches(pattern: string, file: string) {
  const clean = pattern.replace(/^\.\//, "").replace(/\\/g, "/")
  if (!/[*?[]/.test(clean)) {
    const prefix = clean.replace(/\/$/, "")
    if (file === prefix || file.startsWith(`${prefix}/`)) return true
  }
  return Glob.match(clean, file)
}

function line(row: Pick<Row, "id" | "kind" | "body" | "paths">) {
  const scope = row.paths.length ? ` (${row.paths.slice(0, 3).join(", ")})` : ""
  return `- [${row.id}] ${row.kind}${scope}: ${row.body}`
}

function tokensOf(rows: readonly Pick<Row, "id" | "kind" | "body" | "paths">[]) {
  return Token.estimate(rows.map(line).join("\n"))
}

function normalise(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

export function normHash(text: string) {
  return createHash("sha256")
    .update(
      BrainScan.stripHidden(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim(),
    )
    .digest("hex")
    .slice(0, 24)
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

function base32(bytes: Uint8Array) {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function fileId(file: string, key: string) {
  return `f${base32(createHash("sha256").update(`${file}\0${normalise(key)}`).digest()).slice(0, 6)}`
}

function encode(terms: ReadonlyMap<string, number>) {
  return JSON.stringify(Object.fromEntries(terms))
}

function decode(terms: string): ReadonlyMap<string, number> {
  try {
    return new Map(Object.entries(JSON.parse(terms) as Record<string, number>))
  } catch {
    return new Map()
  }
}

function confidence(proposal: Proposal) {
  if (proposal.origin === "user") return 1
  const evidence = proposal.evidence
  if (!evidence || evidence.type === "user" || !evidence.verified) return 0.5
  return evidence.type === "message" ? 0.9 : 0.8
}

function refuse(reason: Refusal, message: string): WriteResult {
  return { type: "refused", reason, message }
}

function byPlace(a: Row, b: Row) {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    (a.source_file ?? "").localeCompare(b.source_file ?? "") ||
    (a.source_line ?? 0) - (b.source_line ?? 0) ||
    b.updated_at - a.updated_at
  )
}

function toEntry(row: Row): BrainSchema.Entry {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    origin: row.origin,
    status: row.status,
    pinned: row.pinned,
    text: row.body,
    paths: row.paths,
    confidence: row.confidence,
    uses: row.uses,
    stale: row.stale,
    ...(row.hold_reason ? { hold: row.hold_reason } : {}),
    ...(row.source_file ? { source: { file: row.source_file, ...(row.source_line ? { line: row.source_line } : {}) } } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    related: row.related,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function removeFailure(file: string, signature: string) {
  const raw = await fs.readFile(file, "utf8").catch(() => "")
  if (!raw) return
  const parsed = (() => {
    try {
      return JSON.parse(raw) as { records?: { signature?: unknown }[] }
    } catch {
      return undefined
    }
  })()
  if (!parsed || !Array.isArray(parsed.records)) return
  const next = { ...parsed, records: parsed.records.filter((record) => record?.signature !== signature) }
  const staged = `${file}.${randomBytes(6).toString("hex")}.tmp`
  await fs.writeFile(staged, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
  await fs.rename(staged, file)
}
