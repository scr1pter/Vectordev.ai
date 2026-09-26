import path from "node:path"
import { createHash, createPublicKey, verify } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises"
import { Option, Schema } from "effect"
import { Teams } from "@vectordevai/schema/teams"
import { Flock } from "../util/flock"

const origin = "https://vectordev.ai"
const State = Schema.Struct({
  version: Schema.Literal(1),
  accountId: Teams.ID,
  selected: Schema.NullOr(Teams.ID),
  envelope: Teams.Envelope,
  revisions: Schema.Record(Teams.ID, Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
})
const decodeState = Schema.decodeUnknownOption(State, { onExcessProperty: "error" })
const decodeEnvelope = Schema.decodeUnknownOption(Teams.Envelope, { onExcessProperty: "error" })
const decodePayload = Schema.decodeUnknownOption(Teams.Payload, { onExcessProperty: "error" })
const decodeKeys = Schema.decodeUnknownOption(Teams.Keys, { onExcessProperty: "error" })

export type TeamsStatus = {
  enabled: boolean
  account?: { id: string; email: string }
  orgs: Array<typeof Teams.Organization.Type>
  active?: { id: string; name: string; revision: number; config: Record<string, Schema.Json> }
}

export class TeamsError extends Error {
  constructor(
    readonly code: "unavailable" | "denied" | "invalid" | "storage",
    message: string,
  ) {
    super(message)
    this.name = "TeamsError"
  }
}

/** The request seam is for isolated tests; production always uses the fixed Vector HTTPS endpoints. */
export function createTeamsClient(input: {
  file: string
  token: () => Promise<string | undefined>
  request?: (url: string, init: RequestInit) => Promise<Response>
  now?: () => number
}) {
  const request = input.request ?? fetch
  const now = input.now ?? Date.now
  const keys = new Map<string, { key: ReturnType<typeof createPublicKey>; expiresAt: number }>()
  const lock = { dir: path.join(path.dirname(input.file), "locks"), timeoutMs: 30_000 }

  async function read() {
    const file = await open(input.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw storageError()
      },
    )
    if (!file) return undefined
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 600_000) throw storageError()
      const value = Schema.decodeUnknownOption(Schema.fromJsonString(State), { onExcessProperty: "error" })(
        await file.readFile("utf8"),
      )
      if (Option.isNone(value)) throw storageError()
      return value.value
    } finally {
      await file.close()
    }
  }

  async function save(state: typeof State.Type) {
    if (Option.isNone(decodeState(state))) throw storageError()
    await mkdir(path.dirname(input.file), { recursive: true, mode: 0o700 })
    const temporary = `${input.file}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" })
      await rename(temporary, input.file)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async function get(url: string, token?: string) {
    const response = await request(url, {
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    }).catch(() => undefined)
    if (!response) throw unavailable()
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      if ([401, 403, 404].includes(response.status))
        throw new TeamsError(
          "denied",
          "Vector could not verify access to that team. Sign in again or choose Personal workspace.",
        )
      throw unavailable()
    }
    return boundedJson(response)
  }

  async function loadKeys() {
    const decoded = decodeKeys(await get(`${origin}/api/org/keys`))
    if (Option.isNone(decoded)) throw invalid()
    const loaded = decoded.value.keys.map((record) => {
      try {
        const bytes = Buffer.from(record.publicKey, "base64url")
        if (bytes.toString("base64url") !== record.publicKey) throw invalid()
        const key = createPublicKey({ key: bytes, format: "der", type: "spki" })
        if (key.asymmetricKeyType !== "ed25519") throw invalid()
        return [record.id, { key, expiresAt: now() + Teams.MAX_AGE_MS }] as const
      } catch {
        throw invalid()
      }
    })
    if (new Set(loaded.map(([id]) => id)).size !== loaded.length) throw invalid()
    keys.clear()
    loaded.forEach(([id, value]) => keys.set(id, value))
  }

  function verified(envelope: typeof Teams.Envelope.Type, token: string, selected: string | null) {
    const key = keys.get(envelope.keyId)
    if (!key || key.expiresAt <= now()) throw invalid()
    const signature = Buffer.from(envelope.signature, "base64url")
    const bytes = Buffer.from(envelope.payload, "base64url")
    if (
      signature.toString("base64url") !== envelope.signature ||
      signature.byteLength !== 64 ||
      bytes.toString("base64url") !== envelope.payload ||
      bytes.byteLength > Teams.MAX_RESPONSE_BYTES ||
      !verify(null, Buffer.from(`vector-org-config-v1.${envelope.payload}`), key.key, signature)
    )
      throw invalid()
    const raw = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(bytes.toString("utf8"))
    if (
      Option.isNone(raw) ||
      !raw.value ||
      typeof raw.value !== "object" ||
      !("active" in raw.value) ||
      (raw.value.active !== null &&
        (!raw.value.active ||
          typeof raw.value.active !== "object" ||
          !("config" in raw.value.active) ||
          !Teams.isConfig(raw.value.active.config)))
    )
      throw invalid()
    const parsed = decodePayload(raw.value)
    if (Option.isNone(parsed)) throw invalid()
    const payload = parsed.value
    if (
      payload.credentialHash !== createHash("sha256").update(token).digest("hex") ||
      payload.issuedAt > now() + 30_000 ||
      payload.expiresAt <= now() ||
      payload.expiresAt <= payload.issuedAt ||
      payload.expiresAt - payload.issuedAt > Teams.MAX_AGE_MS ||
      payload.issuedAt < now() - Teams.MAX_AGE_MS ||
      (payload.active?.id ?? null) !== selected ||
      new Set(payload.orgs.map((org) => org.id)).size !== payload.orgs.length ||
      (payload.active &&
        (!payload.orgs.some((org) => org.id === payload.active!.id) || !Teams.isConfig(payload.active.config)))
    )
      throw invalid()
    return payload
  }

  function status(payload: typeof Teams.Payload.Type): TeamsStatus {
    return {
      enabled: true,
      account: payload.account,
      orgs: [...payload.orgs],
      ...(payload.active
        ? { active: { ...payload.active, name: payload.orgs.find((org) => org.id === payload.active!.id)!.name } }
        : {}),
    }
  }

  async function fetchSnapshot(
    token: string,
    selected: string | null,
    previous?: typeof State.Type,
    expectedAccountID?: string,
  ) {
    // Refresh keys only from the fixed HTTPS authority; disk caches never supply trust anchors.
    await loadKeys()
    const response = decodeEnvelope(await get(`${origin}/api/org/config${selected ? `?org=${selected}` : ""}`, token))
    if (Option.isNone(response)) throw invalid()
    const payload = verified(response.value, token, selected)
    if (expectedAccountID !== undefined && payload.account.id !== expectedAccountID)
      throw new TeamsError(
        "denied",
        "The Vector account changed while selecting a team. Refresh the team list and try again.",
      )
    if (previous?.selected && previous.accountId !== payload.account.id)
      throw new TeamsError(
        "denied",
        "The selected team belongs to another Vector account. Choose Personal workspace before switching accounts.",
      )
    const revisions = previous?.accountId === payload.account.id ? { ...previous.revisions } : {}
    if (payload.active) {
      if (payload.active.revision < (revisions[payload.active.id] ?? 0)) throw invalid()
      revisions[payload.active.id] = payload.active.revision
    }
    if ((await input.token()) !== token)
      throw new TeamsError("denied", "The Vector account changed while loading team configuration. Try again.")
    await save({ version: 1, accountId: payload.account.id, selected, envelope: response.value, revisions })
    return status(payload)
  }

  async function refresh(selected?: string | null, expectedAccountID?: string) {
    await using lease = await Flock.acquire(input.file, lock)
    const previous = await read()
    const chosen = selected === undefined ? (previous?.selected ?? null) : selected
    const token = await input.token()
    if (!token) {
      if (chosen) throw new TeamsError("denied", "Sign in to Vector to refresh the selected team's configuration.")
      return { enabled: false, orgs: [] } satisfies TeamsStatus
    }
    if (chosen && !Schema.is(Teams.ID)(chosen)) throw invalid()
    try {
      return await fetchSnapshot(token, chosen, selected === null ? undefined : previous, expectedAccountID)
    } catch (error) {
      if (!chosen && error instanceof TeamsError && error.code === "unavailable")
        return { enabled: false, orgs: [] } satisfies TeamsStatus
      throw error
    }
  }

  return {
    async current(): Promise<TeamsStatus> {
      await using lease = await Flock.acquire(input.file, lock)
      const previous = await read()
      if (!previous?.selected) return { enabled: false, orgs: [] }
      const token = await input.token()
      if (!token) throw new TeamsError("denied", "Sign in to Vector to refresh the selected team's configuration.")
      const cached = (() => {
        try {
          const value = verified(previous.envelope, token, previous.selected)
          if (
            value.account.id !== previous.accountId ||
            value.active!.revision < (previous.revisions[value.active!.id] ?? 0)
          )
            return undefined
          return value
        } catch {
          return undefined
        }
      })()
      if (cached) return status(cached)
      return await fetchSnapshot(token, previous.selected, previous)
    },
    refresh: () => refresh(),
    async select(id: string | null, expectedAccountID?: string): Promise<TeamsStatus> {
      if (id !== null) return refresh(id, expectedAccountID)
      // Personal mode is an explicit local choice, including while offline or
      // repairing a corrupt selection. An outage must not undo that choice.
      await using lease = await Flock.acquire(input.file, lock)
      await rm(input.file, { force: true })
      keys.clear()
      return { enabled: false, orgs: [] }
    },
    async clear() {
      await using lease = await Flock.acquire(input.file, lock)
      await rm(input.file, { force: true })
      keys.clear()
    },
  }
}

async function boundedJson(response: Response) {
  if (!response.body) throw invalid()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > Teams.MAX_RESPONSE_BYTES) throw invalid()
      chunks.push(next.value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    return value
  } catch {
    throw invalid()
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function unavailable() {
  return new TeamsError(
    "unavailable",
    "Vector Teams is unavailable. Your selected team configuration has not been removed. Reconnect and try again.",
  )
}
function invalid() {
  return new TeamsError(
    "invalid",
    "Vector could not verify the team's signed configuration. Reconnect or ask the team administrator to check its configuration.",
  )
}
function storageError() {
  return new TeamsError(
    "storage",
    "Vector could not read its team selection. Repair teams.json or explicitly choose Personal workspace.",
  )
}
