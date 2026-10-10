import { base64Encode } from "@vectordevai/core/util/encode"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  const directoryKey = directory ? directoryAcceptKey(directory) : undefined
  return autoAccept[key] ?? autoAccept[sessionID] ?? (directoryKey ? autoAccept[directoryKey] : undefined)
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

// Vector Cloud permissions that act on the user's provider accounts:
// publishing and moving production, creating or changing a database and its
// auth, storage and functions (which the provider may bill), hosting settings
// and domains, and the host's environment variables. Auto-accept leaves every
// one of them to the user, and any other cloud request that asks every time
// (no "always" patterns) too. The read-only migration dry run
// (vector_cloud_inspect) is the one cloud request it may answer.
const ALWAYS_ASK = new Set([
  "vector_cloud_publish",
  "vector_cloud_database",
  "vector_cloud_environment",
  "vector_cloud_hosting",
])

export function alwaysAsks(permission: { permission?: string; always?: string[] }) {
  if (!permission.permission?.startsWith("vector_cloud_")) return false
  return ALWAYS_ASK.has(permission.permission) || permission.always?.length === 0
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string; permission?: string; always?: string[] },
  directory?: string,
) {
  if (alwaysAsks(permission)) return false
  const value = sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
  return value ?? false
}
