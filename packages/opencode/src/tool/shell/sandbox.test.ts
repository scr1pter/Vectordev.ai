import { test, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { sandboxAvailability, seatbeltProfile, wrapCommand } from "./sandbox"

const darwin = process.platform === "darwin"
const home = fs.realpathSync(os.homedir())

function workspace(prefix = "sbx-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

function sandboxed(input: { command: string; workspaceRoot: string; cwd?: string; allowNetwork?: boolean }) {
  const wrapped = wrapCommand({
    shell: "/bin/zsh",
    command: input.command,
    cwd: input.cwd ?? input.workspaceRoot,
    env: process.env,
    workspaceRoot: input.workspaceRoot,
    allowNetwork: input.allowNetwork,
  })
  expect(wrapped.sandboxed).toBe(true)
  const result = spawnSync(wrapped.command, wrapped.args, {
    cwd: input.cwd ?? input.workspaceRoot,
    env: process.env,
    encoding: "utf8",
  })
  return { status: result.status, output: (result.stdout + result.stderr).trim() }
}

test("profile grants writes to the workspace and keeps the default deny", () => {
  const profile = seatbeltProfile({ writable: ["/work/space"], denyRead: [], allowNetwork: true })
  expect(profile).toContain("(version 1)")
  expect(profile).toContain("(deny default)")
  expect(profile).toContain('(subpath "/work/space")')
  expect(profile).toContain("(allow file-read*)")
})

test("profile denies reads of secret paths after the broad read allowance", () => {
  const profile = seatbeltProfile({
    writable: ["/work"],
    denyRead: [`${home}/.ssh`, `${home}/.aws`, `${home}/.config/gh`, "/Library/Keychains"],
    allowNetwork: true,
  })
  expect(profile).toContain(`(subpath "${home}/.ssh")`)
  expect(profile).toContain(`(subpath "${home}/.aws")`)
  expect(profile).toContain('(subpath "/Library/Keychains")')
  // SBPL is last-match-wins, so a denial emitted before (allow file-read*) would
  // be silently overridden and the whole protection would be decorative.
  expect(profile.indexOf("(deny file-read*")).toBeGreaterThan(profile.indexOf("(allow file-read*)"))
})

test("paths with quotes and backslashes cannot break out of the profile literal", () => {
  const profile = seatbeltProfile({ writable: ['/work/we"ird\\dir'], denyRead: [], allowNetwork: true })
  expect(profile).toContain('(subpath "/work/we\\"ird\\\\dir")')
  // The escaped literal must contain exactly one opening and one closing quote.
  const rule = profile.split("\n").find((line) => line.includes("we"))
  expect(rule?.match(/(?<!\\)"/g)).toHaveLength(2)
})

test("network switch renders an allow or a unix-only deny", () => {
  expect(seatbeltProfile({ writable: ["/w"], denyRead: [], allowNetwork: true })).toContain("(allow network*)")
  const denied = seatbeltProfile({ writable: ["/w"], denyRead: [], allowNetwork: false })
  expect(denied).toContain("(deny network*)")
  expect(denied).toContain("(allow network* (local unix) (remote unix))")
  expect(denied).not.toContain("\n(allow network*)")
})

test("availability is honest about platforms that cannot be sandboxed", () => {
  const windows = sandboxAvailability("win32")
  expect(windows.supported).toBe(false)
  expect(windows.mechanism).toBe("none")
  expect(windows.reason).toContain("Windows")

  const other = sandboxAvailability("freebsd")
  expect(other.supported).toBe(false)
  expect(other.reason).toContain("freebsd")
})

test("windows keeps the PowerShell invocation and reports that it is unsandboxed", () => {
  const wrapped = wrapCommand({
    shell: "pwsh",
    command: "Get-ChildItem",
    cwd: "C:\\work",
    env: {},
    workspaceRoot: "C:\\work",
    platform: "win32",
  })
  expect(wrapped.command).toBe("pwsh")
  expect(wrapped.args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem"])
  expect(wrapped.shell).toBe(false)
  expect(wrapped.sandboxed).toBe(false)
  expect(wrapped.reason).toContain("Windows")
})

test("windows non-powershell shells still run through the shell option", () => {
  const wrapped = wrapCommand({
    shell: "bash",
    command: "ls -la",
    cwd: "C:\\work",
    env: {},
    workspaceRoot: "C:\\work",
    platform: "win32",
  })
  expect(wrapped.command).toBe("ls -la")
  expect(wrapped.args).toEqual([])
  expect(wrapped.shell).toBe("bash")
  expect(wrapped.sandboxed).toBe(false)
})

test("an unsupported platform degrades to an unwrapped command with a reason", () => {
  const wrapped = wrapCommand({
    shell: "/bin/sh",
    command: "echo hi",
    cwd: "/work",
    env: { FOO: "bar" },
    workspaceRoot: "/work",
    platform: "freebsd",
  })
  expect(wrapped.sandboxed).toBe(false)
  expect(wrapped.mechanism).toBe("none")
  expect(wrapped.reason).toContain("freebsd")
  // Degrading must leave the command exactly as the shell tool would have run it.
  expect(wrapped.command).toBe("echo hi")
  expect(wrapped.shell).toBe("/bin/sh")
  expect(wrapped.env).toEqual({ FOO: "bar" })
})

test.skipIf(!darwin)("macos produces a runnable sandbox-exec invocation", () => {
  const root = workspace()
  const wrapped = wrapCommand({
    shell: "/bin/zsh",
    command: "echo hi",
    cwd: root,
    env: process.env,
    workspaceRoot: root,
  })
  expect(wrapped.sandboxed).toBe(true)
  expect(wrapped.mechanism).toBe("seatbelt")
  expect(wrapped.command).toBe("/usr/bin/sandbox-exec")
  expect(wrapped.args[0]).toBe("-p")
  expect(wrapped.args[1]).toContain(`(subpath "${root}")`)
  expect(wrapped.args.slice(2)).toEqual(["/bin/zsh", "-c", "echo hi"])
  expect(wrapped.shell).toBe(false)
})

test.skipIf(!darwin)("writes inside the workspace succeed and writes to home are refused", () => {
  const root = workspace()
  expect(sandboxed({ command: "echo hi > inside.txt && cat inside.txt", workspaceRoot: root }).output).toBe("hi")

  const escape = path.join(home, "vector-sandbox-escape-probe.txt")
  const denied = sandboxed({ command: `echo pwned > ${escape} && echo WROTE`, workspaceRoot: root })
  expect(denied.output).not.toContain("WROTE")
  expect(denied.status).not.toBe(0)
  expect(fs.existsSync(escape)).toBe(false)
})

test.skipIf(!darwin)("a denied read is enforced by the kernel, not just written into the profile", () => {
  const root = workspace()
  const secret = workspace("secret-")
  fs.writeFileSync(path.join(secret, "key"), "top-secret")

  const profile = seatbeltProfile({ writable: [root], denyRead: [secret], allowNetwork: false })
  const result = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", profile, "/bin/zsh", "-c", `cat ${path.join(secret, "key")}`],
    { cwd: root, env: process.env, encoding: "utf8" },
  )
  expect(result.stdout).not.toContain("top-secret")
  expect(result.status).not.toBe(0)
})

test.skipIf(!darwin)("a secret inside a writable cache root cannot be written either", () => {
  // ~/.gem is a writable cache but ~/.gem/credentials is a denied secret, so the
  // write allowance on the parent must not hand back the credential file.
  const root = workspace()
  const cache = workspace("cache-")
  const secret = path.join(cache, "credentials")
  fs.mkdirSync(secret)

  const profile = seatbeltProfile({ writable: [root, cache], denyRead: [secret], allowNetwork: false })
  const attempt = (target: string) =>
    spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/zsh", "-c", `echo x > ${target} && echo WROTE`], {
      cwd: root,
      env: process.env,
      encoding: "utf8",
    })

  expect(attempt(path.join(cache, "ok.txt")).stdout.trim()).toBe("WROTE")
  expect(attempt(path.join(secret, "key")).stdout).not.toContain("WROTE")
  expect(fs.existsSync(path.join(secret, "key"))).toBe(false)
})

test.skipIf(!darwin)("a workspace path containing a quote stays contained", () => {
  const root = path.join(workspace(), 'we"ird\\dir')
  fs.mkdirSync(root)

  expect(sandboxed({ command: "echo hi > ok.txt && cat ok.txt", workspaceRoot: root, cwd: root }).output).toBe("hi")

  const escape = path.join(home, "vector-sandbox-quote-probe.txt")
  const denied = sandboxed({ command: `echo x > ${escape} && echo WROTE`, workspaceRoot: root, cwd: root })
  expect(denied.output).not.toContain("WROTE")
  expect(fs.existsSync(escape)).toBe(false)
})

test.skipIf(!darwin)("the toolchain stays readable and executable inside the sandbox", () => {
  const root = workspace()
  expect(sandboxed({ command: "git --version", workspaceRoot: root }).status).toBe(0)
  // Redirection to /dev/null and process substitution break under a naive
  // (deny default) profile, so they are worth proving rather than assuming.
  expect(sandboxed({ command: "diff <(echo a) <(echo a) > /dev/null && echo SAME", workspaceRoot: root }).output).toBe(
    "SAME",
  )
  expect(sandboxed({ command: 'T=$(mktemp) && echo x > "$T" && echo TMPOK', workspaceRoot: root }).output).toBe("TMPOK")
})

test.skipIf(!darwin)("the network switch is enforced against a real socket", async () => {
  const root = workspace()
  const server = net.createServer((socket) => socket.end("ok"))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0

  const probe = `nc -z -w 2 127.0.0.1 ${port} > /dev/null 2>&1 && echo CONNECTED || echo BLOCKED`
  expect(sandboxed({ command: probe, workspaceRoot: root, allowNetwork: true }).output).toBe("CONNECTED")
  expect(sandboxed({ command: probe, workspaceRoot: root, allowNetwork: false }).output).toBe("BLOCKED")

  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test.skipIf(!darwin)("a root worktree does not turn into write access to the whole disk", () => {
  const root = workspace()
  const wrapped = wrapCommand({
    shell: "/bin/zsh",
    command: "echo hi",
    cwd: root,
    env: process.env,
    workspaceRoot: "/",
  })
  expect(wrapped.args[1]).not.toContain('(subpath "/")')
  expect(wrapped.args[1]).toContain(`(subpath "${root}")`)

  const escape = path.join(home, "vector-sandbox-root-probe.txt")
  const denied = sandboxed({ command: `echo x > ${escape} && echo WROTE`, workspaceRoot: "/", cwd: root })
  expect(denied.output).not.toContain("WROTE")
  expect(fs.existsSync(escape)).toBe(false)
})

test.skipIf(!darwin)("a profile with no writable roots is still a valid read-only profile", () => {
  const profile = seatbeltProfile({ writable: [], denyRead: [], allowNetwork: false })
  expect(profile).not.toContain("(allow file-write*\n)")
  const result = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/zsh", "-c", "echo alive"], {
    cwd: os.tmpdir(),
    env: process.env,
    encoding: "utf8",
  })
  expect(result.stdout.trim()).toBe("alive")
  expect(result.status).toBe(0)
})
