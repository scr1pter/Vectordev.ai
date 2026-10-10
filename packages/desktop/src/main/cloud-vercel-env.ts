import { createHash } from "node:crypto"

import { applyEnv, listEnv, setEnv } from "./cloud-console"
import {
  booleanField,
  numberField,
  stringField,
  vercelLinkContext,
  vercelPages,
  vercelRequest,
  VercelError,
  type VercelFetch,
  type VercelLinkContext,
} from "./cloud-vercel-api"

// Environment variables on the linked Vercel project. Values only ever travel
// between the user's vault, Vercel and the project's .env: everything this
// module returns carries names, targets and types, never a value.

export const VERCEL_ENV_TARGETS = ["production", "preview", "development"] as const
export type VercelEnvTarget = (typeof VERCEL_ENV_TARGETS)[number]
export type VercelEnvType = "encrypted" | "sensitive" | "plain"

export type VercelRemoteEnv = {
  id: string
  key: string
  type: string
  targets: VercelEnvTarget[]
  gitBranch?: string
  comment?: string
  /** Created by a Vector sync, so a later sync plan may update or delete it. */
  syncedByVector: boolean
  updatedAt?: string
}

export type VercelEnvTargetState = "same" | "different" | "missing_remote" | "remote_only" | "unknown" | "absent"

export type VercelEnvDiffRow = {
  key: string
  local: boolean
  targets: Record<VercelEnvTarget, VercelEnvTargetState>
  /** Branches with their own preview value, which the comparison leaves alone. */
  branchOverrides: string[]
}

export type VercelEnvChange = { action: "create" | "update" | "delete"; key: string; targets: VercelEnvTarget[] }

export type VercelEnvPlan = {
  id: string
  project: string
  targets: VercelEnvTarget[]
  changes: VercelEnvChange[]
  skipped: { key: string; targets: VercelEnvTarget[]; reason: string }[]
  unchanged: number
}

export type VercelEnvPullPlan = {
  id: string
  project: string
  variables: { key: string; action: "add" | "overwrite" | "unchanged" }[]
  skipped: { key: string; reason: string }[]
}

// Every variable a sync creates carries this comment; a sync only ever updates
// or deletes variables that carry it. Older Vector releases used it too.
export const SYNCED_BY_VECTOR = "Synced by Vector"
const SET_IN_VECTOR = "Set in Vector"
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_VALUE_BYTES = 64 * 1024

type RemoteEntry = VercelRemoteEnv & { valueHash?: string }

type SyncOutcome = { operation: Operation } | { skipped: VercelEnvPlan["skipped"][number] } | { unchanged: number }

type Operation =
  | { kind: "create"; key: string; targets: VercelEnvTarget[]; valueHash: string }
  | { kind: "update"; key: string; targets: VercelEnvTarget[]; entry: RemoteEntry; valueHash: string }
  | { kind: "delete"; key: string; targets: VercelEnvTarget[]; entry: RemoteEntry }

// https://vercel.com/docs/rest-api/projects/retrieve-the-environment-variables-of-a-project-by-id-or-name
export async function listVercelEnv(projectPath: string, options: { request?: VercelFetch } = {}) {
  const context = await vercelLinkContext(projectPath)
  const variables = await remoteEntries(context, false, options.request)
  return {
    project: context.link.projectName,
    variables: variables.map(({ valueHash: _hash, ...variable }) => variable),
  }
}

async function remoteEntries(context: VercelLinkContext, decrypt: boolean, request?: VercelFetch) {
  const items = await vercelPages(
    context.auth,
    `/v10/projects/${encodeURIComponent(context.link.projectId)}/env`,
    "envs",
    {
      cursor: "until",
      query: decrypt ? { decrypt: "true" } : undefined,
      request,
    },
  )
  return items.flatMap((item): RemoteEntry[] => {
    const id = stringField(item, "id")
    const key = stringField(item, "key")
    if (!id || !key) return []
    const raw = Reflect.get(item as object, "target")
    const targets = (Array.isArray(raw) ? raw : [raw]).filter((target): target is VercelEnvTarget =>
      VERCEL_ENV_TARGETS.some((known) => known === target),
    )
    const comment = stringField(item, "comment")
    const type = stringField(item, "type") ?? "encrypted"
    const value = Reflect.get(item as object, "value")
    // Only a value Vercel says it decrypted is compared; a sensitive value is
    // never readable and an undecrypted one is ciphertext.
    const readable =
      decrypt && type !== "sensitive" && booleanField(item, "decrypted") !== false && typeof value === "string"
    const updatedAt = numberField(item, "updatedAt")
    return [
      {
        id,
        key,
        type,
        targets,
        gitBranch: stringField(item, "gitBranch"),
        comment,
        syncedByVector: Boolean(comment?.startsWith(SYNCED_BY_VECTOR)),
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : undefined,
        valueHash: readable ? hashValue(value) : undefined,
      },
    ]
  })
}

function hashValue(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

// https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables and
// https://vercel.com/docs/rest-api/projects/edit-an-environment-variable
export async function setVercelEnv(
  projectPath: string,
  input: { key: string; value: string; targets: VercelEnvTarget[]; gitBranch?: string; type?: VercelEnvType },
  options: { request?: VercelFetch } = {},
) {
  const key = input.key.trim()
  if (!KEY_PATTERN.test(key)) {
    throw new VercelError("invalid", `"${key}" is not a valid variable name. Use letters, digits and underscores.`)
  }
  const targets = validTargets(input.targets)
  const gitBranch = input.gitBranch?.trim() || undefined
  if (gitBranch && (targets.length !== 1 || targets[0] !== "preview")) {
    throw new VercelError("invalid", "A branch-specific value can only target preview.")
  }
  const type = input.type ?? "encrypted"
  if (type === "sensitive" && targets.includes("development")) {
    throw new VercelError(
      "invalid",
      "Vercel does not allow sensitive variables in development. Remove development from the targets.",
    )
  }
  if (Buffer.byteLength(input.value) > MAX_VALUE_BYTES) {
    throw new VercelError("invalid", `${key} is larger than Vercel's 64 KB limit for one value.`)
  }
  const context = await vercelLinkContext(projectPath)
  const overlapping = (await remoteEntries(context, false, options.request)).filter(
    (entry) =>
      entry.key === key && entry.gitBranch === gitBranch && entry.targets.some((target) => targets.includes(target)),
  )
  const exact = overlapping.length === 1 && sameTargets(overlapping[0].targets, targets) ? overlapping[0] : undefined
  if (overlapping.length && !exact) {
    throw new VercelError(
      "conflict",
      `${key} already has a value for ${overlapping.flatMap((entry) => entry.targets).join(", ")} in a separate Vercel entry. Remove it from those environments first, or set it for exactly ${overlapping[0].targets.join(", ")}.`,
    )
  }
  const path = `/v10/projects/${encodeURIComponent(context.link.projectId)}/env`
  if (exact) {
    await vercelRequest(
      context.auth,
      `/v9/projects/${encodeURIComponent(context.link.projectId)}/env/${encodeURIComponent(exact.id)}`,
      {
        method: "PATCH",
        body: { value: input.value, ...(input.type ? { type } : {}) },
        request: options.request,
      },
    )
    return { key, targets, gitBranch, action: "updated" as const, project: context.link.projectName }
  }
  const created = await vercelRequest(context.auth, path, {
    method: "POST",
    body: {
      key,
      value: input.value,
      type,
      target: targets,
      ...(gitBranch ? { gitBranch } : {}),
      comment: SET_IN_VECTOR,
    },
    request: options.request,
  })
  rejectFailed(created)
  return { key, targets, gitBranch, action: "created" as const, project: context.link.projectName }
}

// https://vercel.com/docs/rest-api/projects/remove-an-environment-variable. With
// targets, only those environments lose the value; the entry keeps the rest.
export async function removeVercelEnv(
  projectPath: string,
  input: { key: string; targets?: VercelEnvTarget[]; gitBranch?: string },
  options: { request?: VercelFetch } = {},
) {
  const key = input.key.trim()
  const targets = input.targets?.length ? validTargets(input.targets) : [...VERCEL_ENV_TARGETS]
  const gitBranch = input.gitBranch?.trim() || undefined
  const context = await vercelLinkContext(projectPath)
  const entries = (await remoteEntries(context, false, options.request)).filter(
    (entry) =>
      entry.key === key && entry.gitBranch === gitBranch && entry.targets.some((target) => targets.includes(target)),
  )
  if (!entries.length) {
    throw new VercelError(
      "not_found",
      `${key} has no value for ${targets.join(", ")}${gitBranch ? ` on ${gitBranch}` : ""} in ${context.link.projectName}.`,
    )
  }
  for (const entry of entries) await narrowOrDelete(context, entry, targets, options.request)
  return { key, targets, gitBranch, removed: entries.length, project: context.link.projectName }
}

async function narrowOrDelete(
  context: VercelLinkContext,
  entry: RemoteEntry,
  targets: VercelEnvTarget[],
  request?: VercelFetch,
) {
  const remaining = entry.targets.filter((target) => !targets.includes(target))
  const path = `/v9/projects/${encodeURIComponent(context.link.projectId)}/env/${encodeURIComponent(entry.id)}`
  if (remaining.length) {
    await vercelRequest(context.auth, path, { method: "PATCH", body: { target: remaining }, request })
    return
  }
  await vercelRequest(context.auth, path, { method: "DELETE", request })
}

function validTargets(targets: string[]) {
  const unique = VERCEL_ENV_TARGETS.filter((target) => targets.includes(target))
  if (!unique.length || unique.length !== new Set(targets).size) {
    throw new VercelError("invalid", "Choose environments from production, preview and development.")
  }
  return unique
}

function sameTargets(left: VercelEnvTarget[], right: VercelEnvTarget[]) {
  return left.length === right.length && left.every((target) => right.includes(target))
}

function rejectFailed(result: unknown) {
  const failed = result && typeof result === "object" ? Reflect.get(result, "failed") : undefined
  if (!Array.isArray(failed) || !failed.length) return
  // A failure entry can echo the submitted value, so only its code is reported.
  const codes = failed.map((item) => stringField(Reflect.get(item as object, "error"), "code") ?? "error")
  throw new VercelError(
    "provider",
    `Vercel rejected ${failed.length} variable change(s): ${[...new Set(codes)].join(", ")}.`,
  )
}

// Local Vector variables against what Vercel holds for each environment,
// compared by hash in this process. Branch-specific preview values are listed
// but left out of the comparison.
export async function diffVercelEnv(projectPath: string, options: { request?: VercelFetch } = {}) {
  const context = await vercelLinkContext(projectPath)
  const remote = await remoteEntries(context, true, options.request)
  const local = new Map(listEnv(projectPath).map((item) => [item.key, hashValue(item.value)]))
  const keys = [...new Set([...local.keys(), ...remote.map((entry) => entry.key)])].sort()
  const rows = keys.map((key): VercelEnvDiffRow => {
    const localHash = local.get(key)
    const entries = remote.filter((entry) => entry.key === key)
    const shared = entries.filter((entry) => !entry.gitBranch)
    const state = (target: VercelEnvTarget): VercelEnvTargetState => {
      const entry = shared.find((item) => item.targets.includes(target))
      if (!entry) return localHash ? "missing_remote" : "absent"
      if (!localHash) return "remote_only"
      if (!entry.valueHash) return "unknown"
      return entry.valueHash === localHash ? "same" : "different"
    }
    return {
      key,
      local: Boolean(localHash),
      targets: { production: state("production"), preview: state("preview"), development: state("development") },
      branchOverrides: entries.flatMap((entry) => (entry.gitBranch ? [entry.gitBranch] : [])),
    }
  })
  return { project: context.link.projectName, rows }
}

// The writes a sync would make for `targets`: create what is missing, update
// what Vector synced before and now differs, delete what Vector synced before
// and the project no longer has. Variables made outside a Vector sync are
// reported and left alone.
export async function planVercelEnvSync(
  projectPath: string,
  targets: VercelEnvTarget[],
  options: { request?: VercelFetch } = {},
): Promise<VercelEnvPlan> {
  const scoped = validTargets(targets)
  const context = await vercelLinkContext(projectPath)
  const prepared = await prepareSync(context, projectPath, scoped, options.request)
  return { ...prepared.plan, id: prepared.id }
}

async function prepareSync(
  context: VercelLinkContext,
  projectPath: string,
  targets: VercelEnvTarget[],
  request?: VercelFetch,
) {
  const remote = (await remoteEntries(context, true, request)).filter((entry) => !entry.gitBranch)
  const local = listEnv(projectPath)
  // Per local variable: create it where Vercel has none, update what an
  // earlier Vector sync wrote, and leave alone what was set outside a sync.
  const outcomes = local.flatMap((variable): SyncOutcome[] => {
    const valueHash = hashValue(variable.value)
    const missing = targets.filter(
      (target) => !remote.some((entry) => entry.key === variable.key && entry.targets.includes(target)),
    )
    return [
      ...(missing.length
        ? [{ operation: { kind: "create" as const, key: variable.key, targets: missing, valueHash } }]
        : []),
      ...remote
        .filter((entry) => entry.key === variable.key)
        .flatMap((entry): SyncOutcome[] => {
          const covered = entry.targets.filter((target) => targets.includes(target))
          if (!covered.length) return []
          if (!entry.syncedByVector) {
            return [{ skipped: { key: entry.key, targets: covered, reason: "set outside a Vector sync" } }]
          }
          if (entry.valueHash === valueHash) return [{ unchanged: covered.length }]
          return [{ operation: { kind: "update", key: entry.key, targets: covered, entry, valueHash } }]
        }),
    ]
  })
  // What an earlier Vector sync wrote and the local environment no longer has.
  const deletes = remote.flatMap((entry): Operation[] => {
    if (!entry.syncedByVector || local.some((variable) => variable.key === entry.key)) return []
    const covered = entry.targets.filter((target) => targets.includes(target))
    return covered.length ? [{ kind: "delete", key: entry.key, targets: covered, entry }] : []
  })
  const operations = [...outcomes.flatMap((item) => ("operation" in item ? [item.operation] : [])), ...deletes]
  const skipped = outcomes.flatMap((item) => ("skipped" in item ? [item.skipped] : []))
  const unchanged = outcomes.reduce((sum, item) => sum + ("unchanged" in item ? item.unchanged : 0), 0)
  // The id covers every write and every value it would send, so approving a
  // plan approves exactly these writes and nothing that changed since.
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        context.link.projectId,
        targets,
        operations.map((operation) => ({
          kind: operation.kind,
          key: operation.key,
          targets: operation.targets,
          entry: "entry" in operation ? [operation.entry.id, operation.entry.targets, operation.entry.updatedAt] : null,
          value: "valueHash" in operation ? operation.valueHash : null,
        })),
      ]),
    )
    .digest("hex")
    .slice(0, 16)
  return {
    id,
    operations,
    local,
    plan: {
      project: context.link.projectName,
      targets,
      changes: operations.map((operation) => ({
        action: operation.kind,
        key: operation.key,
        targets: operation.targets,
      })),
      skipped,
      unchanged,
    },
  }
}

export async function applyVercelEnvSync(
  projectPath: string,
  targets: VercelEnvTarget[],
  planId: string,
  options: { request?: VercelFetch } = {},
) {
  const scoped = validTargets(targets)
  const context = await vercelLinkContext(projectPath)
  const prepared = await prepareSync(context, projectPath, scoped, options.request)
  if (prepared.id !== planId) {
    throw new VercelError(
      "conflict",
      "The variables changed since this plan was made, so nothing was written. Review the new plan and approve it again.",
    )
  }
  const values = new Map(prepared.local.map((variable) => [variable.key, variable.value]))
  const projectEnv = `/v10/projects/${encodeURIComponent(context.link.projectId)}/env`
  const entryPath = (id: string) =>
    `/v9/projects/${encodeURIComponent(context.link.projectId)}/env/${encodeURIComponent(id)}`
  for (const operation of prepared.operations) {
    if (operation.kind === "delete") {
      await narrowOrDelete(context, operation.entry, operation.targets, options.request)
      continue
    }
    const value = values.get(operation.key) ?? ""
    if (operation.kind === "update" && sameTargets(operation.entry.targets, operation.targets)) {
      await vercelRequest(context.auth, entryPath(operation.entry.id), {
        method: "PATCH",
        body: { value },
        request: options.request,
      })
      continue
    }
    // An entry shared with environments outside this sync keeps them with its
    // old value; the synced environments get an entry of their own.
    if (operation.kind === "update") await narrowOrDelete(context, operation.entry, operation.targets, options.request)
    rejectFailed(
      await vercelRequest(context.auth, projectEnv, {
        method: "POST",
        body: { key: operation.key, value, type: "encrypted", target: operation.targets, comment: SYNCED_BY_VECTOR },
        request: options.request,
      }),
    )
  }
  return {
    ...prepared.plan,
    id: prepared.id,
    applied: prepared.plan.changes.length,
    nextStep: prepared.plan.changes.length
      ? "Redeploy for the new values to take effect: Vercel reads environment variables when it builds."
      : "Nothing needed to change.",
  }
}

// Development values from Vercel that would be written to the project's .env.
export async function planVercelEnvPull(projectPath: string, options: { request?: VercelFetch } = {}) {
  const context = await vercelLinkContext(projectPath)
  return (await preparePull(context, projectPath, options.request)).plan
}

async function preparePull(context: VercelLinkContext, projectPath: string, request?: VercelFetch) {
  const local = new Map(listEnv(projectPath).map((item) => [item.key, item.value]))
  const items = await vercelPages(
    context.auth,
    `/v10/projects/${encodeURIComponent(context.link.projectId)}/env`,
    "envs",
    {
      cursor: "until",
      query: { decrypt: "true" },
      request,
    },
  )
  const values = new Map<string, string>()
  const skipped: VercelEnvPullPlan["skipped"] = []
  for (const item of items) {
    const key = stringField(item, "key")
    const raw = Reflect.get(item as object, "target")
    const targets = Array.isArray(raw) ? raw : [raw]
    if (!key || !targets.includes("development") || stringField(item, "gitBranch")) continue
    const value = Reflect.get(item as object, "value")
    if (
      stringField(item, "type") === "sensitive" ||
      booleanField(item, "decrypted") === false ||
      typeof value !== "string"
    ) {
      skipped.push({ key, reason: "Vercel does not reveal this value" })
      continue
    }
    if (!KEY_PATTERN.test(key)) {
      skipped.push({ key, reason: "not a valid .env name" })
      continue
    }
    if (/[\r\n]/.test(value)) {
      skipped.push({ key, reason: "contains a line break, which .env cannot hold" })
      continue
    }
    values.set(key, value)
  }
  const variables = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({
      key,
      action: !local.has(key)
        ? ("add" as const)
        : local.get(key) === value
          ? ("unchanged" as const)
          : ("overwrite" as const),
    }))
  const id = createHash("sha256")
    .update(
      JSON.stringify([context.link.projectId, [...values.entries()].map(([key, value]) => [key, hashValue(value)])]),
    )
    .update(JSON.stringify(variables))
    .digest("hex")
    .slice(0, 16)
  return { values, plan: { id, project: context.link.projectName, variables, skipped } satisfies VercelEnvPullPlan }
}

// Writes the approved development values into Vector's encrypted store for this
// project and then into the managed block of `directory`'s .env.
export async function applyVercelEnvPull(
  projectPath: string,
  planId: string,
  directory = projectPath,
  options: { request?: VercelFetch } = {},
) {
  const context = await vercelLinkContext(projectPath)
  const prepared = await preparePull(context, projectPath, options.request)
  if (prepared.plan.id !== planId) {
    throw new VercelError(
      "conflict",
      "Vercel's development variables or this project's local ones changed since the preview was made, so nothing was written. Review the new preview and approve it again.",
    )
  }
  const written = prepared.plan.variables.filter((item) => item.action !== "unchanged")
  for (const item of written) setEnv(projectPath, undefined, item.key, prepared.values.get(item.key) ?? "")
  await applyEnv(projectPath, undefined, directory)
  return {
    project: context.link.projectName,
    written: ".env",
    keys: written.map((item) => item.key),
    skipped: prepared.plan.skipped,
  }
}
