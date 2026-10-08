import { open } from "node:fs/promises"

// A bundle starts with a 12-byte header: the magic "VPLG", a format version byte, three reserved bytes and the
// manifest length as a little-endian uint32. The manifest JSON follows the header.
const MAGIC = Buffer.from("VPLG")
const HEADER_BYTES = 12
const FORMAT_VERSION = 2
const MAX_MANIFEST_BYTES = 64 * 1024

export interface PluginManifest {
  name: string
  version: string
  entry: string
  permissions: string[]
}

export class InvalidBundleError extends Error {}

export async function readManifest(path: string): Promise<PluginManifest> {
  const handle = await open(path, "r")
  const header = Buffer.alloc(HEADER_BYTES)
  const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0)
  if (bytesRead < HEADER_BYTES || !header.subarray(0, 4).equals(MAGIC))
    throw new InvalidBundleError(`${path} is not a plugin bundle`)
  if (header[4] !== FORMAT_VERSION)
    throw new InvalidBundleError(`${path} uses bundle format ${header[4]}; this version reads ${FORMAT_VERSION}`)
  const length = header.readUInt32LE(8)
  if (length === 0 || length > MAX_MANIFEST_BYTES) throw new InvalidBundleError(`${path} has a ${length}-byte manifest`)
  const body = Buffer.alloc(length)
  const read = await handle.read(body, 0, length, HEADER_BYTES)
  await handle.close()
  if (read.bytesRead < length) throw new InvalidBundleError(`${path} is truncated`)
  return parseManifest(path, body.toString("utf8"))
}

function parseManifest(path: string, text: string): PluginManifest {
  const value = parseJson(text)
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    typeof value.entry !== "string"
  )
    throw new InvalidBundleError(`${path} has an invalid manifest`)
  const permissions = Array.isArray(value.permissions)
    ? value.permissions.filter((permission): permission is string => typeof permission === "string")
    : []
  return { name: value.name, version: value.version, entry: value.entry, permissions }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
