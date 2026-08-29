import path from "node:path"

const result = Bun.spawnSync(
  [
    "node",
    "--max-old-space-size=6144",
    path.join(path.dirname(Bun.resolveSync("electron-vite/package.json", import.meta.dir)), "bin", "electron-vite.js"),
    "build",
  ],
  {
    cwd: path.dirname(import.meta.dir),
    env: process.env,
    stderr: "inherit",
    stdout: "inherit",
  },
)

if (result.exitCode !== 0) process.exit(result.exitCode)
