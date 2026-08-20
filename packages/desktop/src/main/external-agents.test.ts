import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import {
  agentCandidatePaths,
  agentEnvironment,
  agentOutcome,
  detectExternalAgents,
  executableNames,
  resolveAgentPath,
  shimmedCommand,
} from "./external-agents"

// A real executable in a real directory: the bug being guarded is a CLI that
// exists but is invisible to a GUI-launched app, so nothing here may be faked.
const root = await mkdtemp(join(tmpdir(), "vector-external-agents-"))

async function installFakeCli(directory: string, name: string) {
  await mkdir(directory, { recursive: true })
  const path = join(directory, name)
  await writeFile(path, "#!/bin/sh\necho 1.2.3\n")
  await chmod(path, 0o755)
  return path
}

afterAll(() => rm(root, { recursive: true, force: true }))

describe("external agent resolution", () => {
  test("a CLI invisible under the bare GUI PATH is found once its directory is on PATH", async () => {
    const path = await installFakeCli(join(root, "opt", "toolbox", "bin"), "faux-agent")
    // What a Finder-launched macOS app inherits.
    const guiEnvironment = { HOME: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }

    expect(await resolveAgentPath("faux-agent", guiEnvironment, "darwin")).toBeUndefined()
    expect(
      await resolveAgentPath(
        "faux-agent",
        { ...guiEnvironment, PATH: `${join(root, "opt", "toolbox", "bin")}:/bin` },
        "darwin",
      ),
    ).toBe(path)
  })

  test("finds a CLI installed under a version manager that is off PATH", async () => {
    const nvm = await installFakeCli(join(root, ".nvm", "versions", "node", "v22.14.0", "bin"), "nvm-agent")
    const mise = await installFakeCli(join(root, ".local", "share", "mise", "shims"), "mise-agent")
    const pnpm = await installFakeCli(join(root, "Library", "pnpm"), "pnpm-agent")
    const environment = { HOME: root, PATH: "/usr/bin:/bin" }

    expect(await resolveAgentPath("nvm-agent", environment, "darwin")).toBe(nvm)
    expect(await resolveAgentPath("mise-agent", environment, "darwin")).toBe(mise)
    expect(await resolveAgentPath("pnpm-agent", environment, "darwin")).toBe(pnpm)
  })

  test("a missing CLI resolves to undefined instead of throwing", async () => {
    expect(
      await resolveAgentPath("vector-agent-that-does-not-exist", { HOME: root, PATH: root }, "darwin"),
    ).toBeUndefined()
  })

  test("a non-executable file with the right name is not a CLI", async () => {
    const directory = join(root, "not-executable")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "inert-agent"), "not executable\n")
    await chmod(join(directory, "inert-agent"), 0o644)

    expect(await resolveAgentPath("inert-agent", { HOME: root, PATH: directory }, "darwin")).toBeUndefined()
  })

  test("Windows candidates cover the .cmd/.exe/.ps1 shims npm installs", async () => {
    const paths = (
      await agentCandidatePaths(
        "claude",
        {
          USERPROFILE: "C:\\Users\\dev",
          APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
          LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
          PATH: "C:\\Windows\\System32;C:\\Users\\dev\\tools",
        },
        "win32",
      )
    ).map((path) => path.replace(/\\/g, "/"))

    expect(paths.some((path) => path.endsWith("AppData/Roaming/npm/claude.cmd"))).toBe(true)
    expect(paths.some((path) => path.endsWith("AppData/Roaming/npm/claude.exe"))).toBe(true)
    expect(paths.some((path) => path.endsWith("AppData/Roaming/npm/claude.ps1"))).toBe(true)
    // The Windows PATH is split on ";", not the host platform's separator.
    expect(paths.some((path) => path.endsWith("C:/Windows/System32/claude.exe"))).toBe(true)
    expect(paths.some((path) => path.endsWith("C:/Users/dev/tools/claude.cmd"))).toBe(true)
    expect(paths.some((path) => path.endsWith("AppData/Local/Volta/bin/claude.exe"))).toBe(true)
  })

  test("a directory named like the CLI is not mistaken for the CLI", async () => {
    // access(X_OK) succeeds on directories, so a folder called `code` sitting on
    // PATH would be reported installed and then fail to spawn.
    const bin = join(root, "shadow", "bin")
    await mkdir(join(bin, "code"), { recursive: true })

    expect(await resolveAgentPath("code", { HOME: root, PATH: bin }, "darwin")).toBeUndefined()
  })

  test("a real CLI still wins when a same-named directory is searched first", async () => {
    const shadow = join(root, "shadow-order", "first")
    await mkdir(join(shadow, "shadowed-agent"), { recursive: true })
    const real = await installFakeCli(join(root, "shadow-order", "second"), "shadowed-agent")

    expect(
      await resolveAgentPath(
        "shadowed-agent",
        { HOME: root, PATH: `${shadow}:${join(root, "shadow-order", "second")}` },
        "darwin",
      ),
    ).toBe(real)
  })

  test("Cursor's bundled `code` does not answer for VS Code", async () => {
    // Cursor ships `code` and `cursor` in the same bundle directory. Only the
    // `code` lookup must skip it, or a Cursor-only machine reports VS Code
    // installed at Cursor's version.
    const paths = await agentCandidatePaths("code", { HOME: root, PATH: "/usr/bin" }, "darwin")
    expect(paths.some((path) => path.includes("Cursor.app"))).toBe(false)
    expect(paths).toContain("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")

    const cursor = await agentCandidatePaths("cursor", { HOME: root, PATH: "/usr/bin" }, "darwin")
    expect(cursor).toContain("/Applications/Cursor.app/Contents/Resources/app/bin/cursor")
  })

  test("executable names prefer what Node can spawn directly", () => {
    expect(executableNames("claude", "win32")).toEqual([
      "claude.exe",
      "claude.cmd",
      "claude.bat",
      "claude.ps1",
      "claude",
    ])
    expect(executableNames("claude", "darwin")).toEqual(["claude"])
  })
})

describe("agent environment", () => {
  test("the login shell is probed once and its PATH is unioned with the app's", () => {
    const first = agentEnvironment()
    const second = agentEnvironment()

    // Same object: detectExternalAgents runs on every renderer re-render, and
    // loadShellEnv blocks the main process while the login shell starts.
    expect(second).toBe(first)
    const resolved = (first.PATH ?? "").split(":")
    for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) {
      expect(resolved).toContain(directory)
    }
  })
})

describe("launching a resolved CLI", () => {
  test("a Windows .cmd shim goes through cmd.exe, which is what Node can run", () => {
    const launch = shimmedCommand("C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd", ["-p", 'say "hi"'], "win32")

    expect(launch.command.toLowerCase()).toContain("cmd.exe")
    expect(launch.windowsVerbatimArguments).toBe(true)
    // Verbatim arguments mean cmd.exe sees exactly this string, so the embedded
    // quotes of a prompt have to be doubled rather than escaped.
    expect(launch.args).toEqual([
      "/d",
      "/s",
      "/c",
      '""C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd" "-p" "say ""hi""""',
    ])
  })

  test("everything Node can spawn itself is left alone", () => {
    expect(shimmedCommand("C:\\Users\\dev\\.local\\bin\\claude.exe", ["-p", "hi"], "win32")).toEqual({
      command: "C:\\Users\\dev\\.local\\bin\\claude.exe",
      args: ["-p", "hi"],
      windowsVerbatimArguments: false,
    })
    expect(shimmedCommand("/Users/dev/.local/bin/claude", ["-p", "hi"], "darwin")).toEqual({
      command: "/Users/dev/.local/bin/claude",
      args: ["-p", "hi"],
      windowsVerbatimArguments: false,
    })
  })
})

describe("external agent run outcome", () => {
  // Real Claude Code 2.1.215 output: it exits 0 and reports the failure in the
  // result event, so the exit code alone says the run succeeded.
  const notLoggedIn =
    '[stdout] {"type":"result","subtype":"success","is_error":true,"duration_ms":91,"num_turns":0,"result":"Not logged in · Please run /login","session_id":"a1","total_cost_usd":0}'

  test("is_error in the result event is a failure even when the CLI exits 0", () => {
    const outcome = agentOutcome("claude-code", 0, [
      '[stdout] {"type":"result","subtype":"success","is_error":true,"result":"Tool use was denied by the user"}',
    ])

    expect(outcome.exitCode).toBe(1)
    expect(outcome.error).toBe("Tool use was denied by the user")
  })

  test("an authentication failure names the sign-in command", () => {
    const outcome = agentOutcome("claude-code", 0, [notLoggedIn])

    expect(outcome.exitCode).toBe(1)
    expect(outcome.error).toContain("not signed in")
    expect(outcome.error).toContain("Not logged in · Please run /login")
    expect(outcome.error).toContain("`claude`")
    expect(outcome.error).not.toContain("not installed")
  })

  test("a signed-out CLI that only writes to stderr still names the sign-in command", () => {
    const outcome = agentOutcome("cursor", 1, ["[stderr] Error: Unauthorized. Run cursor-agent login to continue."])

    expect(outcome.exitCode).toBe(1)
    expect(outcome.error).toContain("`cursor-agent login`")
  })

  test("codex sign-in guidance uses the Codex command", () => {
    const outcome = agentOutcome("codex", 1, ['[stderr] {"type":"error","is_error":true,"message":"Not logged in"}'])

    expect(outcome.error).toContain("`codex`")
  })

  test("a clean run stays a success and a plain crash keeps its exit code", () => {
    expect(
      agentOutcome("claude-code", 0, [
        '[stdout] {"type":"result","subtype":"success","is_error":false,"result":"Done"}',
      ]),
    ).toEqual({
      exitCode: 0,
    })

    const crashed = agentOutcome("claude-code", 2, ["[stderr] TypeError: cannot read property of undefined"])
    expect(crashed.exitCode).toBe(2)
    expect(crashed.error).toBe("Claude Code exited with code 2.")
  })

  test("a tool call that failed mid-run does not fail the whole run", () => {
    // Claude Code puts a failed tool's is_error inside message.content[], not at
    // the top level of the event — only the final result event speaks for the
    // run. Matching is_error anywhere would fail every run containing a grep
    // that found nothing.
    const outcome = agentOutcome("claude-code", 0, [
      '[stdout] {"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"No files found","is_error":true}]},"parent_tool_use_id":null,"session_id":"a1"}',
      '[stdout] {"type":"result","subtype":"success","is_error":false,"result":"Renamed the helper","total_cost_usd":0.03}',
    ])

    expect(outcome).toEqual({ exitCode: 0 })
  })

  test("a normal edit that mentions unauthorized is not mistaken for a sign-out", () => {
    const outcome = agentOutcome("claude-code", 0, [
      '[stdout] {"type":"assistant","message":{"content":"Added a 401 Unauthorized branch to the router"}}',
      '[stdout] {"type":"result","subtype":"success","is_error":false,"result":"Added the branch"}',
    ])

    expect(outcome).toEqual({ exitCode: 0 })
  })
})

describe("external agent detection on this machine", () => {
  test("detects the installed Claude Code CLI and reports its version", async () => {
    const agents = await detectExternalAgents()
    const claude = agents.find((agent) => agent.id === "claude-code")

    expect(claude?.installed).toBe(true)
    expect(claude?.path).toContain("claude")
    expect(claude?.version).toMatch(/\d+\.\d+\.\d+/)
  }, 60_000)

  test("reports uninstalled runtimes without throwing", async () => {
    const agents = await detectExternalAgents()

    expect(agents.map((agent) => agent.id)).toEqual(["claude-code", "codex", "cursor", "vscode"])
    for (const agent of agents) {
      if (agent.installed) continue
      expect(agent.path).toBeUndefined()
      expect(agent.version).toBeUndefined()
    }
  }, 60_000)
})
