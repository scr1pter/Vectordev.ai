import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { isNushell, mergeShellEnv, parseShellEnv, resolveUserShell, toolBinDirectories } from "./shell-env"

describe("shell env", () => {
  test("parseShellEnv supports null-delimited pairs", () => {
    const env = parseShellEnv(Buffer.from("PATH=/usr/bin:/bin\0FOO=bar=baz\0\0"))

    expect(env.PATH).toBe("/usr/bin:/bin")
    expect(env.FOO).toBe("bar=baz")
  })

  test("parseShellEnv ignores invalid entries", () => {
    const env = parseShellEnv(Buffer.from("INVALID\0=empty\0OK=1\0"))

    expect(Object.keys(env).length).toBe(1)
    expect(env.OK).toBe("1")
  })

  test("mergeShellEnv keeps explicit overrides", () => {
    const env = mergeShellEnv(
      {
        PATH: "/shell/path",
        HOME: "/tmp/home",
      },
      {
        PATH: "/desktop/path",
        VECTOR_CLIENT: "desktop",
      },
    )

    expect(env.PATH).toBe("/desktop/path")
    expect(env.HOME).toBe("/tmp/home")
    expect(env.VECTOR_CLIENT).toBe("desktop")
  })

  test("resolveUserShell falls back to the login shell before /bin/sh", () => {
    expect(resolveUserShell("/custom/env-shell", "/bin/zsh")).toBe("/custom/env-shell")
    expect(resolveUserShell(undefined, "/bin/zsh")).toBe("/bin/zsh")
    expect(resolveUserShell(undefined, "unknown")).toBe("/bin/sh")
    expect(resolveUserShell(undefined, undefined)).toBe("/bin/sh")
  })

  test("isNushell handles path and binary name", () => {
    expect(isNushell("nu")).toBe(true)
    expect(isNushell("/opt/homebrew/bin/nu")).toBe(true)
    expect(isNushell("C:\\Program Files\\nu.exe")).toBe(true)
    expect(isNushell("/bin/zsh")).toBe(false)
  })

  test("Windows looks where winget, Scoop and Chocolatey put the GitHub CLI", () => {
    // A running app keeps its launch PATH, so these are how a gh installed afterwards is found.
    const directories = toolBinDirectories(
      {
        USERPROFILE: "C:\\Users\\ada",
        LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
      },
      "win32",
    )
    expect(directories).toContain(join("C:\\Program Files", "GitHub CLI"))
    expect(directories).toContain(join("C:\\Users\\ada\\AppData\\Local", "Microsoft", "WinGet", "Links"))
    expect(directories).toContain(join("C:\\Users\\ada", "scoop", "shims"))
    expect(directories).toContain(join("C:\\ProgramData\\chocolatey", "bin"))
  })

  test("Windows looks where Git for Windows installs git.exe", () => {
    const directories = toolBinDirectories(
      {
        USERPROFILE: "C:\\Users\\ada",
        LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
      },
      "win32",
    )
    expect(directories).toContain(join("C:\\Program Files", "Git", "cmd"))
    expect(directories).toContain(join("C:\\Users\\ada\\AppData\\Local", "Programs", "Git", "cmd"))
  })
})
