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
  /** Entries the agent may write per request message, whatever becomes of them; past it, writes are refused. */
  perMessage: 3,
  /** Entries waiting for review (proposed or held) that one session may leave, and that one scope may hold. */
  pendingPerSession: 50,
  pending: 200,
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

/** Recalled memory as a request carries it; nothing at all for no lines. */
export function recallText(lines: readonly string[]) {
  if (lines.length === 0) return ""
  return [
    "<vector_memory_recall>",
    "Memory that may bear on this request. Rules bind; the rest is advisory, so check it against the code:",
    ...lines,
    "</vector_memory_recall>",
  ].join("\n")
}

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

export type Refusal =
  | "secret"
  | "forgotten"
  | "empty"
  | "too-long"
  | "learning-off"
  | "file-entry"
  | "user-entry"
  | "not-found"
  | "limit"

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

export type Injection = {
  readonly text?: string
  readonly ids: readonly string[]
  readonly tokens: number
  /** Recall only: which of `ids` are the user's personal memory. */
  readonly personal?: readonly string[]
  /** Recall only: the text without personal memory, which is all a session's saved transcript may keep. */
  readonly shared?: string
}

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
  /** Active entries as recall shows them, by id, for a request that fills recalled memory back in. */
  readonly lines: (
    place: Place,
    ids: readonly string[],
    options: { readonly personal: boolean },
  ) => Effect.Effect<ReadonlyMap<string, string>>
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
  /** How many entries this session's agent wrote since `since`, whatever their status, for the per-message write cap. */
  readonly written: (sessionID: string, since: number) => Effect.Effect<number>
  /** The user's own memory and rules files, which the brain reads and never writes. */
  readonly files: () => { readonly memory: string; readonly rules: string }
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
    /** A repository's own file: a link is followed only where it lands inside this working tree. */
    readonly root?: string
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
      root: place.root,
    })),
    { path: failureFile(place), repository: place.repository, scope: "repository", type: "failures", held: false },
  ]

  const mirror = Effect.fnUntraced(function* (source: Mirror) {
    const stat = yield* Effect.promise(() => statFollowing(source))
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
        // A key pasted into MEMORY.md or a rules file is not sent on to a provider either.
        body: BrainScan.redact(BrainScan.stripHidden(item.text)).text,
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
    const rendered = render(source, content, rows)
    const digest = rendered?.text ? { ...rendered, text: BrainScan.redact(rendered.text).text } : rendered
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
    const text = recallText(picked.map(line))
    const tokens = Token.estimate(text)
    yield* used(
      picked.map((row) => row.id),
      input.sessionID,
      "recall",
      tokens,
    )
    const personal = picked.filter((row) => row.repository_id === PERSONAL)
    return {
      text,
      ids: picked.map((row) => row.id),
      tokens,
      personal: personal.map((row) => row.id),
      shared: recallText(picked.filter((row) => row.repository_id !== PERSONAL).map(line)),
    }
  })

  const lines = Effect.fn("Brain.lines")(function* (place: Place, ids: readonly string[], options: { personal: boolean }) {
    if (ids.length === 0) return new Map<string, string>()
    const rows = yield* db
      .select()
      .from(BrainEntryTable)
      .where(and(inArray(BrainEntryTable.id, [...ids]), visible(place, options.personal), eq(BrainEntryTable.status, "active")))
      .all()
      .pipe(Effect.orDie)
    return new Map(rows.map((row) => [row.id, line(row)]))
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
          eq(BrainEntryTable.origin, "agent"),
          sql`${BrainEntryTable.created_at} >= ${since}`,
        ),
      )
      .all()
      .pipe(Effect.orDie)
    return rows.length
  })

  // What waits for review in one scope, and how much of it one session left there.
  const waiting = Effect.fnUntraced(function* (repository: string, sessionID: string | undefined) {
    const rows = yield* db
      .select({ session: BrainEntryTable.origin_session_id })
      .from(BrainEntryTable)
      .where(
        and(
          eq(BrainEntryTable.repository_id, repository),
          inArray(BrainEntryTable.origin, [...LEARNED]),
          inArray(BrainEntryTable.status, ["proposed", "quarantined"]),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    return { all: rows.length, session: sessionID ? rows.filter((row) => row.session === sessionID).length : 0 }
  })

  // Evidence is kept only as far as it was checked, and never with a secret or a hidden character in it: get and export
  // show it, and get sends it to the provider.
  const evidenceRow = (entry: string, evidence: Evidence | undefined, sessionID: string | undefined, checked: boolean) => {
    const base = { entry_id: entry, session_id: sessionID ?? null, created_at: Date.now() }
    if (!evidence || evidence.type === "user") return { ...base, type: "user" as const }
    if (evidence.type === "message") return { ...base, type: "message" as const, quote: checked ? scrub(evidence.quote) : null }
    if (evidence.type === "file")
      return {
        ...base,
        type: "file" as const,
        path: scrub(evidence.path),
        quote: checked ? scrub(evidence.quote) : null,
        file_hash: checked ? (evidence.hash ?? null) : null,
      }
    return { ...base, type: "check" as const, command: checked ? scrub(evidence.command) : null }
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

  // A replacement that waited (for review, or for a second session) replaces its entry once it is in use. Only the
  // user's approval replaces what the user wrote.
  const settle = Effect.fnUntraced(function* (id: string, actor: "user" | "agent" | "vector") {
    const targets = (yield* db
      .select()
      .from(BrainEventTable)
      .where(and(eq(BrainEventTable.entry_id, id), eq(BrainEventTable.action, "added")))
      .all()
      .pipe(Effect.orDie)).flatMap((item) => (typeof item.detail?.pending === "string" ? [item.detail.pending] : []))
    if (targets.length === 0) return
    yield* db
      .update(BrainEntryTable)
      .set({ status: "superseded", superseded_by: id, updated_at: Date.now() })
      .where(
        and(
          inArray(BrainEntryTable.id, targets),
          inArray(BrainEntryTable.status, ["active", "proposed"]),
          actor === "user" ? undefined : ne(BrainEntryTable.origin, "user"),
        ),
      )
      .run()
      .pipe(Effect.orDie)
  })

  const propose = Effect.fn("Brain.propose")(function* (place: Place, proposal: Proposal) {
    const agent = proposal.origin === "agent"
    if (agent && !(yield* learning()))
      return refuse("learning-off", "Learning is turned off in Settings > Memory, so nothing was saved.")
    const hiddenText = BrainScan.hidden(proposal.text)
    const cleaned = BrainScan.stripHidden(proposal.text).replace(/\s+/g, " ").trim()
    if (!cleaned) return refuse("empty", "Nothing to save.")
    const limit = agent ? LIMIT.agent : LIMIT.user
    if (cleaned.length > limit)
      return refuse("too-long", `Keep one memory to ${limit} characters: one fact, lesson or decision per entry.`)
    const redacted = BrainScan.redact(cleaned)
    if (redacted.redacted && BrainScan.remainder(redacted.text) < 16)
      return refuse("secret", "That is a secret. Memory never stores secrets, keys, tokens or passwords.")
    const text = redacted.text
    const evidence = proposal.evidence
    // Evidence counts only for what it says: a quote has to state the memory, and a check has to be the one it names.
    const verified =
      !agent || (evidence !== undefined && evidence.type !== "user" && evidence.verified && supports(text, evidence))
    // The user's own words: what they wrote in Settings, or a checked quote of what they said in this conversation.
    const said = !agent || (verified && evidence?.type === "message")
    // Personal memory follows the user into every repository, so it takes what they said about themselves.
    const own = !agent || (said && evidence?.type === "message" && FIRST_PERSON.test(evidence.quote))
    const previous = proposal.supersedes ? yield* find(place, proposal.supersedes, true) : undefined
    if (proposal.supersedes && !previous) return refuse("not-found", `No memory ${proposal.supersedes} here.`)
    if (previous && !LEARNED.includes(previous.origin))
      return refuse(
        "file-entry",
        `${previous.id} comes from ${previous.source_file ? path.basename(previous.source_file) : "a file"}; ask the user to edit that file.`,
      )
    // A replacement keeps the scope of what it replaces, and only the user's words change what the user wrote.
    if (previous?.scope === "personal" && !own)
      return refuse("not-found", `${previous.id} is the user's own memory; quote what they said about themselves to change it.`)
    if (previous?.origin === "user" && !said)
      return refuse(
        "user-entry",
        `${previous.id} is the user's own entry; quote what they said to change it, or ask them to edit it in Settings > Memory.`,
      )
    const scope: BrainSchema.Scope = (previous?.scope ?? proposal.scope) === "personal" && own ? "personal" : "repository"
    const repository = scope === "personal" ? PERSONAL : place.repository
    const hash = normHash(text)
    if (agent && (yield* tombstoned(repository, hash)))
      return refuse("forgotten", "The user asked Vector to forget this, so it was not saved again.")
    const hold = !agent
      ? undefined
      : (proposal.hold ?? (hiddenText ? "hidden-unicode" : BrainScan.instructionLike(text) ? "instruction-like" : undefined))

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
    const words = BrainLexical.terms([text, ...(proposal.paths ?? [])].join(" "))
    const now = Date.now()

    // The same words again: the entry gains this evidence, a proposal a second session wrote too is confirmed, and the
    // user writing what waits for review approves it.
    const exact = peers.find((row) => row.norm_hash === hash && row.id !== previous?.id)
    if (exact) {
      // A held write never adds to an entry outside the review queue, so outside content cannot vouch for memory.
      if (hold && exact.status !== "quarantined") return { type: "merged" as const, entry: toEntry(exact) }
      const confirms =
        exact.status === "proposed" &&
        (verified || (proposal.sessionID !== undefined && exact.origin_session_id !== proposal.sessionID))
      const restores = exact.status === "archived" && verified
      const approves = !agent && exact.status === "quarantined"
      const status: BrainSchema.Status = confirms || restores || approves ? "active" : exact.status
      // What the user wrote themselves is theirs, so the agent cannot put it away later.
      const origin = agent ? exact.origin : "user"
      const next = {
        status,
        origin,
        hold_reason: approves ? null : exact.hold_reason,
        confidence: Math.max(exact.confidence, confidence(proposal, verified)),
        updated_at: now,
        paths: [...new Set([...exact.paths, ...(proposal.paths ?? [])])],
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.update(BrainEntryTable).set(next).where(eq(BrainEntryTable.id, exact.id)).run()
            yield* tx.insert(BrainEvidenceTable).values(evidenceRow(exact.id, evidence, proposal.sessionID, verified)).run()
          }),
        )
        .pipe(Effect.orDie)
      if (status === "active" && exact.status !== "active") yield* settle(exact.id, proposal.origin)
      yield* event(exact, confirms ? "promoted" : approves ? "approved" : "merged", proposal.origin)
      yield* bump(repository)
      const entry = toEntry({ ...exact, ...next })
      if (status === "quarantined") return { type: "held" as const, entry }
      if (status === "proposed") return { type: "proposed" as const, entry }
      return { type: confirms || approves ? ("promoted" as const) : ("merged" as const), entry }
    }

    // A different wording of a known entry. Nothing is folded into the old words: a correction and the old text can
    // share every term ("Use npm, not pnpm" and "Use pnpm, not npm"), so only a wording that adds nothing to it merges.
    const similar = previous || hold
      ? undefined
      : peers
          .filter((row) => row.kind === proposal.kind && (row.status === "active" || row.status === "proposed"))
          .map((row) => ({ row, score: BrainLexical.similarity(decode(row.terms), words) }))
          .filter((item) => item.score >= SIMILAR)
          .toSorted((a, b) => b.score - a.score)[0]?.row
    const fresh = { body: text, terms: words }
    if (similar && agent && similar.status === "active" && within(fresh, { body: similar.body, terms: decode(similar.terms) })) {
      if (verified)
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(BrainEntryTable)
                .set({ confidence: Math.max(similar.confidence, confidence(proposal, verified)), updated_at: now })
                .where(eq(BrainEntryTable.id, similar.id))
                .run()
              yield* tx.insert(BrainEvidenceTable).values(evidenceRow(similar.id, evidence, proposal.sessionID, true)).run()
            }),
          )
          .pipe(Effect.orDie)
      yield* event(similar, "merged", proposal.origin)
      if (verified) yield* bump(repository)
      return { type: "merged" as const, entry: toEntry(similar) }
    }
    // A second session that writes every word of an unchecked proposal again confirms it; only words both wrote go live.
    if (
      similar &&
      agent &&
      !verified &&
      similar.status === "proposed" &&
      proposal.sessionID !== undefined &&
      similar.origin_session_id !== proposal.sessionID &&
      within({ body: similar.body, terms: decode(similar.terms) }, fresh)
    ) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.update(BrainEntryTable).set({ status: "active", updated_at: now }).where(eq(BrainEntryTable.id, similar.id)).run()
            yield* tx.insert(BrainEvidenceTable).values(evidenceRow(similar.id, evidence, proposal.sessionID, false)).run()
          }),
        )
        .pipe(Effect.orDie)
      yield* settle(similar.id, "agent")
      yield* event(similar, "promoted", proposal.origin)
      yield* bump(repository)
      return { type: "promoted" as const, entry: toEntry({ ...similar, status: "active", updated_at: now }) }
    }
    // Otherwise the newer words replace it when the user wrote them, or when the agent checked them (and the old entry
    // is not the user's, or the user said so here); an unchecked or contested wording waits for review beside it.
    const replaces = previous ?? (similar && (!agent || (verified && (similar.origin !== "user" || said))) ? similar : undefined)
    const contested = similar !== undefined && replaces === undefined

    if (agent && proposal.sessionID !== undefined && proposal.since !== undefined) {
      if ((yield* written(proposal.sessionID, proposal.since)) >= LIMIT.perMessage)
        return refuse(
          "limit",
          `Vector already saved ${LIMIT.perMessage} memories for this message. Keep only the ones that matter most.`,
        )
    }
    const status: BrainSchema.Status = hold ? "quarantined" : verified && !contested ? "active" : "proposed"
    if (status !== "active") {
      const queue = yield* waiting(repository, proposal.sessionID)
      if (queue.session >= LIMIT.pendingPerSession || queue.all >= LIMIT.pending)
        return refuse(
          "limit",
          "Enough memory already waits for the user's review. Ask them to go through Settings > Memory before saving more.",
        )
    }
    const pending = replaces ?? (contested ? similar : undefined)
    const id = yield* freshId()
    const related = peers
      .filter((row) => row.status === "active")
      .map((row) => ({ id: row.id, score: BrainLexical.similarity(decode(row.terms), words) }))
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
      terms: encode(words),
      norm_hash: hash,
      confidence: confidence(proposal, verified),
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
          yield* tx.insert(BrainEvidenceTable).values(evidenceRow(id, evidence, proposal.sessionID, verified)).run()
          // A replacement that waits leaves the entry it replaces in use until it is approved or confirmed.
          if (replaces && status === "active")
            yield* tx
              .update(BrainEntryTable)
              .set({ status: "superseded", superseded_by: id, updated_at: now })
              .where(eq(BrainEntryTable.id, replaces.id))
              .run()
          if (!agent)
            yield* tx
              .delete(BrainTombstoneTable)
              .where(and(eq(BrainTombstoneTable.repository_id, repository), eq(BrainTombstoneTable.norm_hash, hash)))
              .run()
        }),
      )
      .pipe(Effect.orDie)
    yield* event(
      row,
      replaces && status === "active" ? "superseded" : "added",
      proposal.origin,
      replaces && status === "active" ? { previous: replaces.id } : pending ? { pending: pending.id } : undefined,
    )
    if (status === "active") yield* capacity(repository)
    yield* bump(repository)
    const entry = toEntry(row)
    if (status === "quarantined") return { type: "held" as const, entry }
    if (status === "proposed") return { type: "proposed" as const, entry }
    if (replaces) return { type: "superseded" as const, entry, previous: replaces.id }
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
    // The agent changes only what it learned itself; what the user wrote or a file says is theirs to change.
    if (actor === "agent" && row.origin !== "agent")
      return refuse("user-entry", `${row.id} is the user's own; ask them to change it in Settings > Memory.`)
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
      yield* settle(id, actor)
      yield* event(row, "approved", actor)
    }
    if (change.action === "reject" && (row.status === "proposed" || row.status === "quarantined")) {
      if (!learned) return refuse("file-entry", "This comes from a file; edit the file to change it.")
      yield* forgetRow(row)
      return { type: "merged" as const, entry: toEntry({ ...row, status: "archived" }) }
    }
    if ((change.action === "archive" || change.action === "restore") && !learned)
      return refuse("file-entry", `${row.id} comes from ${row.source_file ? path.basename(row.source_file) : "a file"}; edit that file.`)
    if (change.action === "archive" && row.status === "active") {
      yield* db.update(BrainEntryTable).set({ status: "archived", updated_at: now }).where(eq(BrainEntryTable.id, id)).run().pipe(Effect.orDie)
      yield* event(row, "archived", actor)
    }
    if (change.action === "restore" && (row.status === "archived" || row.status === "superseded")) {
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
            inArray(BrainEntryTable.status, ["active", "proposed", "quarantined"]),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      // 1. Near-duplicates of an entry in use merge into one: the user's wording first, then a checked one, then the
      //    newest. Two proposals never merge, so tidying cannot confirm words no session checked, and a correction
      //    (a different turn of the same words) stays apart. Entries are bucketed by term, so a pass compares only
      //    entries that share words, and each one's terms are decoded once.
      const live = rows.filter((row) => row.status !== "quarantined").toSorted((a, b) => a.created_at - b.created_at)
      const decoded = new Map(live.map((row) => [row.id, decode(row.terms)]))
      const turns = new Map(live.map((row) => [row.id, BrainLexical.polarity(row.body)]))
      const order = new Map(live.map((row, index) => [row.id, index]))
      const buckets = new Map<string, Row[]>()
      for (const row of live)
        for (const term of decoded.get(row.id)!.keys()) {
          const bucket = buckets.get(term)
          if (bucket) bucket.push(row)
          else buckets.set(term, [row])
        }
      const gone = new Set<string>()
      for (const row of live.filter((item) => item.status === "active")) {
        if (gone.has(row.id)) continue
        const terms = decoded.get(row.id)!
        const shared = new Map<string, { other: Row; count: number }>()
        for (const term of terms.keys())
          for (const other of buckets.get(term) ?? []) {
            if (other.id === row.id || gone.has(other.id)) continue
            // A pair of entries in use is looked at once, from the older one.
            if (other.status === "active" && order.get(other.id)! < order.get(row.id)!) continue
            shared.set(other.id, { other, count: (shared.get(other.id)?.count ?? 0) + 1 })
          }
        const matches = [...shared.values()]
          .filter(({ other, count }) => {
            if (other.kind !== row.kind || turns.get(other.id) !== turns.get(row.id)) return false
            return count / (terms.size + decoded.get(other.id)!.size - count) >= SIMILAR
          })
          .map((item) => item.other)
          .toSorted((a, b) => order.get(a.id)! - order.get(b.id)!)
        for (const other of matches) {
          if (gone.has(row.id)) break
          const keeper = rank(other) > rank(row) || (rank(other) === rank(row) && other.status === "active") ? other : row
          const loser = keeper === row ? other : row
          if (loser.pinned) continue
          gone.add(loser.id)
          counts.merged++
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .update(BrainEvidenceTable)
                  .set({ entry_id: keeper.id })
                  .where(eq(BrainEvidenceTable.entry_id, loser.id))
                  .run()
                yield* tx
                  .update(BrainEntryTable)
                  .set({ status: "superseded", superseded_by: keeper.id, updated_at: now })
                  .where(eq(BrainEntryTable.id, loser.id))
                  .run()
                yield* tx
                  .update(BrainEntryTable)
                  .set({
                    uses: keeper.uses + loser.uses,
                    paths: [...new Set([...keeper.paths, ...loser.paths])],
                    updated_at: now,
                  })
                  .where(eq(BrainEntryTable.id, keeper.id))
                  .run()
              }),
            )
            .pipe(Effect.orDie)
          // Later merges into the same keeper add to what it has now.
          keeper.uses += loser.uses
          keeper.paths = [...new Set([...keeper.paths, ...loser.paths])]
          yield* event(loser, "merged", "vector", { into: keeper.id })
        }
      }
      const kept = rows.filter((row) => !gone.has(row.id))
      // 2. A proposal two sessions arrived at is confirmed; one nobody confirmed in 30 days is dropped, and so is an
      //    entry held for review that the user has not looked at in 30 days.
      const proposals = kept.filter((row) => row.status === "proposed")
      const sessions = proposals.length
        ? yield* db
            .selectDistinct({ entry: BrainEvidenceTable.entry_id, session: BrainEvidenceTable.session_id })
            .from(BrainEvidenceTable)
            .where(inArray(BrainEvidenceTable.entry_id, proposals.map((row) => row.id)))
            .all()
            .pipe(Effect.orDie)
        : []
      for (const row of kept) {
        if (row.status === "quarantined") {
          if (now - row.created_at <= 30 * DAY) continue
          counts.dropped++
          yield* db.delete(BrainEntryTable).where(eq(BrainEntryTable.id, row.id)).run().pipe(Effect.orDie)
          continue
        }
        if (row.status === "proposed") {
          if (sessions.filter((item) => item.entry === row.id && item.session).length >= 2) {
            counts.promoted++
            yield* db.update(BrainEntryTable).set({ status: "active", updated_at: now }).where(eq(BrainEntryTable.id, row.id)).run().pipe(Effect.orDie)
            yield* settle(row.id, "vector")
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
    lines,
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
    files: () => personalFiles,
  }
}

// --- Helpers --------------------------------------------------------------------------------------------------------

// A mirrored file, following a link: people keep MEMORY.md and RULES.md in a dotfiles folder and link them in. A
// repository's own link counts only where it lands inside the working tree, as its instruction files do, so a clone
// cannot feed ~/.ssh/id_rsa into a prompt as "rules".
async function statFollowing(source: { readonly path: string; readonly root?: string }) {
  const link = await fs.lstat(source.path).catch(() => undefined)
  if (!link?.isSymbolicLink()) return link
  const target = await fs.realpath(source.path).catch(() => undefined)
  if (!target) return undefined
  if (source.root) {
    const root = await fs.realpath(source.root).catch(() => path.resolve(source.root!))
    const inside = path.relative(root, target)
    if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined
  }
  return fs.stat(target).catch(() => undefined)
}

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
    // A scoped rule binds as much as any other and is a line long, so it goes in whole too: attached only when a file
    // is read, it never reached a file the agent wrote, patched or changed through bash.
    const omit = (item: BrainParse.Item) => {
      const row = byLine.get(item.line)
      return item.kind === "review" || row?.status !== "active"
    }
    const text = BrainParse.rulesText(BrainScan.stripHidden(content), omit)
    return {
      ...(text ? { text } : {}),
      ids: rows.filter((row) => row.status === "active" && row.kind === "rule").map((row) => row.id),
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

// Which wording of a duplicate tidying keeps: the user's own, then one in use (checked), then a proposal.
function rank(row: Pick<Row, "origin" | "status">) {
  if (row.origin === "user") return 2
  return row.status === "active" ? 1 : 0
}

function confidence(proposal: Proposal, verified: boolean) {
  if (proposal.origin === "user") return 1
  if (!verified) return 0.5
  return proposal.evidence?.type === "message" ? 0.9 : 0.8
}

/** Texts this alike are one entry's wordings: a duplicate, or a correction of it. */
const SIMILAR = 0.72

// A quote has to state at least half of a memory's terms to count as evidence for it.
const SUPPORT = 0.5

// Personal memory is what the user said about themselves.
const FIRST_PERSON = /\b(?:i|me|my|mine|myself)\b/i

function supports(text: string, evidence: Exclude<Evidence, { readonly type: "user" }>) {
  if (evidence.type === "check") return BrainLexical.named(text, evidence.command)
  return BrainLexical.coverage(text, evidence.quote) >= SUPPORT
}

/** Whether one wording says nothing the other does not: every term of it, turned the same way. */
function within(
  inner: { readonly body: string; readonly terms: ReadonlyMap<string, number> },
  outer: { readonly body: string; readonly terms: ReadonlyMap<string, number> },
) {
  return (
    BrainLexical.polarity(inner.body) === BrainLexical.polarity(outer.body) &&
    [...inner.terms.keys()].every((term) => outer.terms.has(term))
  )
}

function scrub(value: string) {
  return BrainScan.redact(BrainScan.stripHidden(value)).text.slice(0, 240)
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
