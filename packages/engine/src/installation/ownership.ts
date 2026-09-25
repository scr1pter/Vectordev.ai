import path from "node:path"
import { readFile, realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import { Schema, Option } from "effect"
import { Standalone } from "./standalone"

export type Method = "npm" | "pnpm" | "bun" | "standalone" | "homebrew" | "scoop" | "unknown"
export type Owner =
  | { method: "standalone"; receipt: Standalone.Receipt }
  | { method: "npm" | "pnpm" | "bun"; package: "@vectordevai/cli" }
  | { method: "homebrew" | "scoop"; package: string; latest: string }
  | { method: "unknown" }

const Brew = Schema.Struct({
  formulae: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      full_name: Schema.String,
      homepage: Schema.String,
      versions: Schema.Struct({ stable: Schema.NullOr(Schema.String) }),
    }),
  ),
})
const ScoopInstall = Schema.Struct({ bucket: Schema.String })
const ScoopManifest = Schema.Struct({ version: Schema.String, homepage: Schema.String })
const decode = <A, I>(schema: Schema.Codec<A, I>, value: string) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(value))
const ownedHomepage = (value: string) => /^https:\/\/vectordev\.ai\/?$/.test(value)

export async function detect(run: Standalone.Run, executable = process.execPath): Promise<Owner> {
  const managed = await Standalone.receipt(executable)
  if (managed) return { method: "standalone", receipt: managed }
  const binary = await realpath(executable).catch(() => undefined)
  if (!binary || !/^vector(?:\.exe)?$/.test(path.basename(binary))) return { method: "unknown" }
  const normalized = binary.replaceAll("\\", "/")
  const cellar = normalized.match(/\/Cellar\/([^/]+)\/[^/]+\/bin\/vector$/)
  if (cellar) {
    const result = await run(["brew", "info", "--json=v2", "--installed", cellar[1]!])
    const info = result.code === 0 ? decode(Brew, result.stdout) : undefined
    const formula = info?.formulae.find(
      (value) =>
        value.name === cellar[1] &&
        ownedHomepage(value.homepage) &&
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/vector$/.test(value.full_name),
    )
    if (formula?.versions.stable) {
      const prefix = await run(["brew", "--prefix", formula.full_name])
      const owned =
        prefix.code === 0 && (await realpath(path.join(prefix.stdout.trim(), "bin/vector")).catch(() => undefined))
      if (owned === binary) return { method: "homebrew", package: formula.full_name, latest: formula.versions.stable }
    }
    return { method: "unknown" }
  }
  const scoop = normalized.match(/\/apps\/vector\/[^/]+\/vector\.exe$/i)
  if (scoop) {
    const directory = path.dirname(binary)
    const install = decode(ScoopInstall, await readFile(path.join(directory, "install.json"), "utf8").catch(() => ""))
    const manifest = decode(
      ScoopManifest,
      await readFile(path.join(directory, "manifest.json"), "utf8").catch(() => ""),
    )
    if (install && /^[A-Za-z0-9_.-]+$/.test(install.bucket) && manifest && ownedHomepage(manifest.homepage)) {
      const result = await run(["scoop", "cat", `${install.bucket}/vector`])
      const available = result.code === 0 ? decode(ScoopManifest, result.stdout) : undefined
      if (available && ownedHomepage(available.homepage))
        return { method: "scoop", package: `${install.bucket}/vector`, latest: available.version }
    }
    return { method: "unknown" }
  }
  for (const method of ["npm", "pnpm", "bun"] as const) {
    const result = await run(method === "bun" ? ["bun", "pm", "bin", "-g"] : [method, "root", "-g"])
    if (result.code !== 0 || !path.isAbsolute(result.stdout.trim())) continue
    const packageFile =
      method === "bun"
        ? await realpath(path.join(result.stdout.trim(), "vector"))
            .then((file) => path.join(path.dirname(file), "../package.json"))
            .catch(() => undefined)
        : path.join(result.stdout.trim(), "@vectordevai/cli/package.json")
    if (!packageFile) continue
    const metadata = decode(Schema.Struct({ name: Schema.String }), await readFile(packageFile, "utf8").catch(() => ""))
    if (metadata?.name !== "@vectordevai/cli") continue
    const match = normalized.match(
      /\/@vectordevai\/(cli-(?:darwin|linux|windows)-(?:arm64|x64))\/bin\/vector(?:\.exe)?$/,
    )
    if (!match) continue
    const dependency = await Promise.resolve()
      .then(() => createRequire(packageFile).resolve(`@vectordevai/${match[1]}/package.json`))
      .catch(() => undefined)
    if (!dependency) continue
    const installed: string | undefined = await realpath(
      path.join(path.dirname(dependency), "bin", path.basename(binary)),
    ).catch(() => undefined)
    if (installed === binary) return { method, package: "@vectordevai/cli" }
  }
  return { method: "unknown" }
}

export * as InstallationOwnership from "./ownership"
