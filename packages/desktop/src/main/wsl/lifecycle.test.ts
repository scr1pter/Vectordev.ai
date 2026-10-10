import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { redactWslOutput, wslLaunchEnvironment, wslProcessLifetime } from "./lifecycle"
import { wslServerScript } from "./scripts"

const shellTest = process.platform === "win32" ? test.skip : test

test("WSL launch strips inherited credentials, shell hooks and tracing before the stdin handoff", () => {
  const env = wslLaunchEnvironment({
    PATH: "/bin",
    VECTOR_CLI_TOKEN: "vct_previous",
    VECTOR_CREDENTIAL_KEY: "master",
    BASH_ENV: "hook",
    ENV: "hook",
    SHELLOPTS: "xtrace",
    BASHOPTS: "verbose",
    WSLENV: "VECTOR_CLI_TOKEN/u",
  })
  expect(env).toEqual({ PATH: "/bin", WSLENV: "" })
  expect(redactWslOutput("token=vct_fixture pass=password", ["vct_fixture", "password"])).toBe(
    "token=[redacted] pass=[redacted]",
  )
})

for (const stubborn of [false, true]) {
  shellTest(
    `stdin EOF stops the owned Linux child and descendants (ignores TERM: ${stubborn})`,
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "vector-wsl-supervisor-"))
      const binary = path.join(home, "native")
      await Bun.write(
        binary,
        `#!/bin/bash\n${stubborn ? "trap '' TERM" : ":"}\nsleep 60 &\nprintf 'ready:%s:%s:%s:%s\\n' "$$" "$!" "$VECTOR_CLI_TOKEN" "$VECTOR_DISABLE_USAGE"\nwait\n`,
      )
      await chmod(binary, 0o755)
      const child = spawn("/bin/bash", ["--noprofile", "--norc", "-se"], {
        env: wslLaunchEnvironment({ HOME: home, PATH: "/usr/bin:/bin", SHELLOPTS: "xtrace:verbose" }),
        stdio: ["pipe", "pipe", "pipe"],
      })
      const lifetime = wslProcessLifetime(child)
      const output: string[] = []
      const errors: string[] = []
      child.stdout.on("data", (data) => output.push(data.toString()))
      child.stderr.on("data", (data) => errors.push(data.toString()))
      child.stdin.write(
        wslServerScript({
          binary,
          port: 1234,
          logLevel: "WARN",
          env: { VECTOR_CLI_TOKEN: "vct_fixture", VECTOR_SERVER_PASSWORD: "synthetic-password" },
        }),
      )
      try {
        await waitFor(() => /ready:.*\n/.test(output.join("")))
        expect(child.spawnargs.join(" ")).not.toContain("vct_fixture")
        expect(errors.join("")).not.toContain("vct_fixture")
        // The server never sends usage counts itself, whatever the desktop's Share usage counts switch says.
        const [, pid, descendant] = output.join("").match(/ready:(\d+):(\d+):vct_fixture:1\n/)!
        expect(Number(pid)).not.toBe(process.pid)
        await lifetime.stop()
        await waitFor(() => !alive(Number(pid)) && !alive(Number(descendant)))
        expect(alive(process.pid)).toBe(true)
      } finally {
        child.kill("SIGKILL")
        await lifetime.exited
        await rm(home, { recursive: true, force: true })
      }
    },
    10_000,
  )
}

shellTest("failed termination remains a rejected operation and can be retried after exit", async () => {
  const child = spawn("/bin/sleep", ["60"], { stdio: ["pipe", "pipe", "pipe"] })
  const lifetime = wslProcessLifetime(child, 20)
  try {
    await expect(lifetime.stop()).rejects.toThrow("could not confirm")
    expect(child.exitCode).toBeNull()
  } finally {
    child.kill("SIGKILL")
    await lifetime.exited
  }
  await expect(lifetime.stop()).resolves.toBeUndefined()
})

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function waitFor(check: () => boolean) {
  for (let count = 0; count < 200; count++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for fixture process")
}
