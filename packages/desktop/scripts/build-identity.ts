import type { Channel } from "./utils"

export const BUILD_IDENTITY_FILE = "vector-build.json"

export type BuildIdentity = {
  schemaVersion: 1
  channel: Channel
  version: string
  revision?: string
}

export function createBuildIdentity(input: { channel: Channel; version: string; revision?: string }): BuildIdentity {
  const revision = input.revision?.trim()
  return {
    schemaVersion: 1,
    channel: input.channel,
    version: input.version,
    ...(revision ? { revision } : {}),
  }
}

export function parseBuildIdentity(contents: string): BuildIdentity | undefined {
  try {
    const value: unknown = JSON.parse(contents)
    if (!value || typeof value !== "object") return
    if (!("schemaVersion" in value) || value.schemaVersion !== 1) return
    if (!("channel" in value) || !["dev", "beta", "prod"].includes(String(value.channel))) return
    if (!("version" in value) || typeof value.version !== "string" || !value.version.trim()) return
    if ("revision" in value && value.revision !== undefined && typeof value.revision !== "string") return
    return value as BuildIdentity
  } catch {
    return
  }
}
