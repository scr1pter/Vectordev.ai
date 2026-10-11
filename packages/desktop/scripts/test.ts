import path from "node:path"
import { createRequire } from "node:module"

const directory = path.resolve(import.meta.dir, "..")
const require = createRequire(import.meta.url)

// Packaging fixtures need the locked Electron runtime and its license files even after an install that skipped
// dependency scripts. The official installer verifies its pinned checksums and is a no-op when already installed.
const installed = await Bun.spawn([process.execPath, "--no-env-file", require.resolve("electron/install.js")], {
  cwd: directory,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
}).exited
if (installed !== 0) process.exit(installed)

const files = (await Array.fromAsync(new Bun.Glob("**/*.{test,spec}.{ts,tsx}").scan({ cwd: directory })))
  .filter((file) => !file.split(/[\\/]/).includes("node_modules"))
  .sort()
if (!files.length) throw new Error("No Desktop test files found")

// Electron and store module mocks survive mock.restore() in Bun. Each file owns its fixtures and temp data, so
// isolate files in child processes while retaining every test, platform skip and failure in the canonical suite.
const failed: string[] = []
for (const file of files) {
  console.log(`\nDesktop test: ${file}`)
  const status = await Bun.spawn(
    [process.execPath, "--no-env-file", "test", "--timeout", "30000", "--only-failures", `./${file}`],
    {
      cwd: directory,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  ).exited
  if (status !== 0) failed.push(file)
}
console.log(`\nDesktop: ${files.length - failed.length}/${files.length} test files passed`)
if (failed.length) {
  console.error(`Failed test files:\n${failed.join("\n")}`)
  process.exit(1)
}
