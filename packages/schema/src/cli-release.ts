export * as CliRelease from "./cli-release.js"

import { Schema } from "effect"

export const MAX_MANIFEST_BYTES = 64_000
export const MAX_ARCHIVE_BYTES = 1_000_000_000
export const targets = [
  "darwin-arm64",
  "darwin-x64",
  "darwin-x64-baseline",
  "linux-arm64",
  "linux-x64",
  "linux-x64-baseline",
  "linux-arm64-musl",
  "linux-x64-musl",
  "linux-x64-baseline-musl",
  "windows-arm64",
  "windows-x64",
  "windows-x64-baseline",
] as const
export const Target = Schema.Literals(targets)
export type Target = typeof Target.Type
export const Version = Schema.String.check(
  Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/),
  Schema.isMaxLength(100),
)
export const Channel = Schema.Literals(["latest", "beta"])
export type Channel = typeof Channel.Type
export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Asset = Schema.Struct({
  filename: Schema.String,
  pathname: Schema.String,
  url: Schema.String,
  size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_ARCHIVE_BYTES)),
  sha256: Digest,
})
export type Asset = typeof Asset.Type
export const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  version: Version,
  channel: Channel,
  publishedAt: Schema.String,
  sourceRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  catalogSha256: Digest,
  targets: Schema.Record(Schema.String, Asset),
})
export type Manifest = typeof Manifest.Type
export const Selection = Schema.Struct({ version: Version, target: Target, ...Asset.fields })
export type Selection = typeof Selection.Type

export function filename(target: Target) {
  return `vector-${target}.${target.startsWith("windows-") ? "zip" : "tar.gz"}`
}

export function manifestPath(version: string = "latest") {
  if (Schema.is(Channel)(version)) return `releases/vector-cli/${version}.json`
  Schema.decodeUnknownSync(Version)(version)
  return `releases/vector-cli/v${version}/manifest.json`
}

export function archivePath(version: string, target: Target) {
  Schema.decodeUnknownSync(Version)(version)
  return `releases/vector-cli/v${version}/${filename(target)}`
}

export function decode(value: unknown, expectedOrigin?: string): Manifest {
  const manifest = Schema.decodeUnknownSync(Manifest, { onExcessProperty: "error" })(value)
  if (Object.keys(manifest.targets).sort().join("\n") !== [...targets].sort().join("\n"))
    throw new Error("The Vector CLI release must contain all twelve native targets.")
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.publishedAt) ||
    !Number.isFinite(Date.parse(manifest.publishedAt)) ||
    new Date(manifest.publishedAt).toISOString() !== manifest.publishedAt
  )
    throw new Error("The Vector CLI release has an invalid publication time.")
  if (manifest.channel === "latest" && manifest.version.includes("-"))
    throw new Error("A prerelease cannot replace the stable Vector CLI release.")
  const origins = new Set<string>()
  for (const target of targets) {
    const asset = manifest.targets[target]!
    const url = new URL(asset.url)
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9]+\.public\.blob\.vercel-storage\.com$/.test(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      asset.filename !== filename(target) ||
      asset.pathname !== archivePath(manifest.version, target) ||
      asset.url !== `${url.origin}/${asset.pathname}` ||
      (expectedOrigin !== undefined && url.origin !== expectedOrigin)
    )
      throw new Error(`The Vector CLI archive is invalid: ${target}.`)
    origins.add(url.origin)
  }
  if (origins.size !== 1) throw new Error("The Vector CLI release mixes storage origins.")
  return manifest
}

export function select(manifest: Manifest, target: Target): Selection {
  Schema.decodeUnknownSync(Target)(target)
  return { version: manifest.version, target, ...manifest.targets[target]! }
}

export function tsv(value: Selection) {
  return `${value.version}\t${value.target}\t${value.url}\t${value.size}\t${value.sha256}\n`
}
