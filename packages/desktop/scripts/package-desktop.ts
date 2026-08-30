import path from "node:path"
import { BUILD_IDENTITY_FILE, parseBuildIdentity } from "./build-identity"

type PackageTarget = "mac" | "win" | "linux"

export function packageRequest(input: {
  argv: readonly string[]
  version: string
  environmentChannel?: string
  unsignedRelease?: boolean
}) {
  // Bun's named scripts insert --target before a caller's forwarding separator.
  // The separator belongs to the script runner, not electron-builder's parser.
  const argv = input.argv.filter((arg) => arg !== "--")
  const inlineChannel = argv.find((arg) => arg.startsWith("--channel="))?.slice("--channel=".length)
  const channelFlag = argv.indexOf("--channel")
  const separateChannel = channelFlag >= 0 ? argv[channelFlag + 1] : undefined
  const requestedChannel = inlineChannel ?? separateChannel
  if (inlineChannel && separateChannel && inlineChannel !== separateChannel) {
    throw new Error("Package channel was provided twice with different values")
  }
  if (requestedChannel && input.environmentChannel && requestedChannel !== input.environmentChannel) {
    throw new Error(`Package channel ${requestedChannel} does not match OPENCODE_CHANNEL=${input.environmentChannel}`)
  }
  const channel = requestedChannel ?? input.environmentChannel
  if (channel !== "dev" && channel !== "beta" && channel !== "prod") {
    throw new Error("Packaging requires an explicit channel: --channel dev|beta|prod or OPENCODE_CHANNEL")
  }

  const targetValue = argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
  if (targetValue && targetValue !== "mac" && targetValue !== "win" && targetValue !== "linux") {
    throw new Error(`Unsupported package target: ${targetValue}`)
  }
  const target = targetValue as PackageTarget | undefined
  const requestedBuilderArgs = argv.filter((arg, index) => {
    if (arg.startsWith("--channel=") || arg.startsWith("--target=")) return false
    if (arg === "--channel" || (channelFlag >= 0 && index === channelFlag + 1)) return false
    return true
  })
  const targetedBuilderArgs = target ? [`--${target}`, ...requestedBuilderArgs] : requestedBuilderArgs
  const publishFlag = targetedBuilderArgs.indexOf("--publish")
  const publish =
    targetedBuilderArgs.find((arg) => arg.startsWith("--publish="))?.slice("--publish=".length) ??
    (publishFlag >= 0 ? targetedBuilderArgs[publishFlag + 1] : undefined)
  if (input.unsignedRelease && channel === "prod" && publish && publish !== "never") {
    throw new Error("Unsigned production artifacts are manual-download-only and cannot publish an update feed")
  }
  return {
    channel,
    target,
    environment: { OPENCODE_CHANNEL: channel, OPENCODE_VERSION: input.version },
    builderArgs:
      input.unsignedRelease && channel === "prod" && !publish
        ? [...targetedBuilderArgs, "--publish", "never"]
        : targetedBuilderArgs,
  }
}

export function macPackagePaths(input: {
  builderArgs: readonly string[]
  channel: "dev" | "beta" | "prod"
  hostArchitecture: string
}) {
  const architectureFlags = ["x64", "arm64", "universal"].filter((arch) => input.builderArgs.includes(`--${arch}`))
  const macFlag = input.builderArgs.findIndex((arg) => arg === "--mac" || arg.startsWith("--mac="))
  const remaining = input.builderArgs.slice(macFlag + 1)
  const nextFlag = remaining.findIndex((arg) => arg.startsWith("-"))
  const targets = input.builderArgs[macFlag]?.startsWith("--mac=")
    ? [input.builderArgs[macFlag].slice("--mac=".length)]
    : remaining.slice(0, nextFlag < 0 ? undefined : nextFlag)
  const architectures = [
    ...new Set(
      (targets.length ? targets : [""]).flatMap((target) => {
        const explicit = target.split(":")[1]
        if (explicit) return [explicit]
        return architectureFlags.length ? architectureFlags : [input.hostArchitecture]
      }),
    ),
  ]
  const name = input.channel === "prod" ? "Vector" : input.channel === "beta" ? "Vector Beta" : "Vector Dev"
  // electron-builder omits the suffix for x64. Do not scan all dist/mac*:
  // another architecture may still contain an unrelated, older package.
  return architectures.map((arch) => path.join("dist", arch === "x64" ? "mac" : `mac-${arch}`, `${name}.app`))
}

if (import.meta.main) {
  const packageDir = path.dirname(import.meta.dir)
  const manifest: unknown = await Bun.file(path.join(packageDir, "package.json")).json()
  if (!manifest || typeof manifest !== "object" || !("version" in manifest) || typeof manifest.version !== "string") {
    throw new Error("Desktop package.json has no version")
  }
  const request = packageRequest({
    argv: process.argv.slice(2),
    version: manifest.version,
    environmentChannel: Bun.env.OPENCODE_CHANNEL,
    unsignedRelease: Bun.env.VECTOR_ALLOW_UNSIGNED_RELEASE === "true",
  })
  const environment = { ...process.env, ...request.environment }
  run([process.execPath, "run", "build"], packageDir, environment, "Desktop build failed")

  const identity = parseBuildIdentity(await Bun.file(path.join(packageDir, "out", BUILD_IDENTITY_FILE)).text())
  if (!identity || identity.channel !== request.channel || identity.version !== manifest.version) {
    throw new Error("Desktop build identity does not match the requested package channel and version")
  }

  const builder = path.join(path.dirname(Bun.resolveSync("electron-builder/package.json", import.meta.dir)), "cli.js")
  run(
    ["node", builder, "--config", "electron-builder.config.ts", ...request.builderArgs],
    packageDir,
    environment,
    "Desktop packaging failed",
  )

  if (request.target === "mac" || request.builderArgs.some((arg) => arg === "--mac" || arg.startsWith("--mac="))) {
    for (const appPath of macPackagePaths({
      builderArgs: request.builderArgs,
      channel: request.channel,
      hostArchitecture: process.arch,
    })) {
      run(
        [process.execPath, "./scripts/verify-package.ts", appPath],
        packageDir,
        environment,
        "Packaged app verification failed",
      )
    }
  }
}

function run(command: string[], cwd: string, env: Record<string, string | undefined>, message: string) {
  const result = Bun.spawnSync(command, { cwd, env, stderr: "inherit", stdout: "inherit" })
  if (result.exitCode !== 0) throw new Error(`${message} with exit code ${result.exitCode}`)
}
