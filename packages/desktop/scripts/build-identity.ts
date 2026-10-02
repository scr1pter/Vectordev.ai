// Relative, so electron-vite bundles it when it loads the config: Node cannot load the schema's TypeScript
// directly, because its imports name the .js files the website's serverless functions need.
import { CliRelease } from "../../schema/src/cli-release"
import { Schema } from "effect"
import type { Channel } from "./utils"

export const BUILD_IDENTITY_FILE = "vector-build.json"

export type BuildIdentity = {
  schemaVersion: 1
  channel: Channel
  version: string
  requiredCliVersion: string
  revision?: string
}

export function createBuildIdentity(input: {
  channel: Channel
  version: string
  requiredCliVersion: string
  revision?: string
}): BuildIdentity {
  const revision = input.revision?.trim()
  return {
    schemaVersion: 1,
    channel: input.channel,
    version: input.version,
    requiredCliVersion: requiredCliVersion(input.requiredCliVersion),
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
    if (!("requiredCliVersion" in value) || !Schema.is(CliRelease.Version)(value.requiredCliVersion)) return
    if ("revision" in value && value.revision !== undefined && typeof value.revision !== "string") return
    return value as BuildIdentity
  } catch {
    return
  }
}

export function requiredCliVersion(value: unknown, override?: string) {
  const version = override ?? value
  if (!Schema.is(CliRelease.Version)(version))
    throw new Error("The desktop build requires an exact vectorRequiredCliVersion or VECTOR_REQUIRED_CLI_VERSION.")
  return version
}

export function stampDesktopVersion<T extends { version: string; vectorRequiredCliVersion?: unknown }>(
  manifest: T,
  version: string,
  override?: string,
) {
  return {
    ...manifest,
    version,
    vectorRequiredCliVersion: requiredCliVersion(manifest.vectorRequiredCliVersion, override),
  }
}
