import path from "node:path"
import { BUILD_IDENTITY_FILE, createBuildIdentity } from "./build-identity"
import { resolveChannel } from "./utils"

const packageDir = path.dirname(import.meta.dir)
const channel = resolveChannel()

const result = Bun.spawnSync(
  [
    "node",
    "--max-old-space-size=6144",
    path.join(path.dirname(Bun.resolveSync("electron-vite/package.json", import.meta.dir)), "bin", "electron-vite.js"),
    "build",
  ],
  {
    cwd: packageDir,
    env: { ...process.env, OPENCODE_CHANNEL: channel },
    stderr: "inherit",
    stdout: "inherit",
  },
)

if (result.exitCode !== 0) process.exit(result.exitCode)

const manifest: unknown = await Bun.file(path.join(packageDir, "package.json")).json()
if (!manifest || typeof manifest !== "object" || !("version" in manifest) || typeof manifest.version !== "string") {
  throw new Error("Desktop package.json has no version")
}

await Bun.write(
  path.join(packageDir, "out", BUILD_IDENTITY_FILE),
  `${JSON.stringify(
    createBuildIdentity({
      channel,
      version: manifest.version,
      revision: Bun.env.GITHUB_SHA ?? Bun.env.VERCEL_GIT_COMMIT_SHA,
    }),
    null,
    2,
  )}\n`,
)
console.log(`Embedded ${channel} build identity in out/${BUILD_IDENTITY_FILE}`)
