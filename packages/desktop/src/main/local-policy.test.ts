import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// The desktop's main process as it starts: the backstop is its first import, before the desktop's folders are set, and
// resolveDesktopLocal runs once preferAppEnv has set them. Each run is a process of its own, with a home of its own.

const CORE = path.join(import.meta.dir, "../../../core/src/local-mode")
const script = `import ${JSON.stringify(path.join(CORE, "backstop.ts"))}
import path from "node:path"
import { Egress } from ${JSON.stringify(path.join(CORE, "egress.ts"))}
const started = Egress.policy().pending === true
const { resolveDesktopLocal } = await import(${JSON.stringify(path.join(import.meta.dir, "local-policy.ts"))})
// What preferAppEnv sets.
const userData = process.env.USER_DATA
Object.assign(process.env, {
  VECTOR_CLIENT: "desktop",
  VECTOR_AGENT_CONFIG_DIR: path.join(userData, "config", "vector"),
  XDG_STATE_HOME: path.join(userData, "xdg-state"),
})
const policy = resolveDesktopLocal(userData)
const account = Egress.decide({ source: "vector-account", url: "https://vectordev.ai/api/account/profile" })
console.log(JSON.stringify({ started, pending: policy.pending === true, enabled: policy.enabled, account: account.rule }))
`

const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

const start = async (home: string) => {
  const file = path.join(home, "main.ts")
  writeFileSync(file, script)
  const child = Bun.spawn([process.execPath, file], {
    env: { PATH: process.env.PATH ?? "", HOME: home, USER_DATA: path.join(home, "user-data") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const line = stdout.trim().split("\n").at(-1) ?? ""
  if (!line.startsWith("{")) throw new Error(`The desktop main script printed no result:\n${stdout}\n${stderr}`)
  return JSON.parse(line) as Record<string, unknown>
}

describe("desktop main's Vector Local policy", () => {
  test("does not stay pending when only the CLI's config turns Vector Local on", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "vector-desktop-local-"))
    try {
      write(path.join(home, ".config", "vector", "vector.json"), { local: { enabled: true } })
      expect(await start(home)).toEqual({ started: true, pending: false, enabled: false, account: "local-off" })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("decides under the policy the desktop's own config sets", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "vector-desktop-local-"))
    try {
      // The global folder the desktop's engine reads, and then the desktop's own folder.
      for (const file of [
        path.join(home, "user-data", "xdg-config", "vector", "vector.json"),
        path.join(home, "user-data", "config", "vector", "vector.json"),
      ]) {
        write(file, { local: { enabled: true } })
        const result = await start(home)
        // Its account requests are refused as Vector's own service, not held as if Vector Local were still starting.
        expect({ file, ...result }).toEqual({
          file,
          started: false,
          pending: false,
          enabled: true,
          account: "vector-service",
        })
        rmSync(file)
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
