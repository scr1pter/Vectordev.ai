import { describe, expect, test } from "bun:test"
import {
  isLaunchableBundle,
  openPathApplication,
  openPathArguments,
  openPathCommand,
  requireOpenPathApplication,
  requireOpenPathDirectory,
} from "./open-path"

describe("open path applications", () => {
  test("maps supported renderer labels to a main-owned application id", () => {
    expect(openPathApplication("Visual Studio Code")).toBe("vscode")
    expect(openPathApplication("cursor")).toBe("cursor")
    expect(openPathApplication("/Applications/Calculator.app")).toBeUndefined()
  })

  test("rejects arbitrary executables from IPC", () => {
    for (const value of ["/bin/sh", "cmd.exe", "../../malware", "vscode\n--args"]) {
      expect(() => requireOpenPathApplication(value)).toThrow("unsupported application")
    }
    expect(() => requireOpenPathDirectory("/tmp/tool", { directory: false })).toThrow("existing directory")
    expect(() => requireOpenPathDirectory(undefined, { directory: true })).toThrow("existing directory")
  })

  test("opens a plain folder but never an application or other bundle", () => {
    expect(requireOpenPathDirectory("/work/project", { directory: true, bundle: false })).toBe("/work/project")
    for (const path of [
      "/Applications/Calculator.app",
      "/tmp/x.app/",
      "/Library/PreferencePanes/a.prefPane",
      "/tmp/i.pkg",
    ])
      expect(isLaunchableBundle(path, false)).toBe(true)
    expect(isLaunchableBundle("/tmp/folder-named-anything", true)).toBe(true)
    expect(isLaunchableBundle("/work/my.application-notes", false)).toBe(false)
    expect(() => requireOpenPathDirectory("/Applications/Calculator.app", { directory: true, bundle: true })).toThrow(
      "not applications",
    )
  })

  test("only launches a resolved Windows executable", () => {
    expect(openPathCommand("vscode", "win32", "C:\\Program Files\\VS Code\\Code.exe")).toEndWith("Code.exe")
    expect(() => openPathCommand("vscode", "win32", "C:\\tools\\code.cmd")).toThrow("safe executable")
  })

  test("passes PowerShell a data-only encoded working directory", () => {
    const path = "C:\\work'; Start-Process calc; '"
    const args = openPathArguments("powershell", "win32", path)
    const script = Buffer.from(args[2], "base64").toString("utf16le")

    expect(args.slice(0, 2)).toEqual(["-NoExit", "-EncodedCommand"])
    expect(args).not.toContain(path)
    expect(script).toBe("Set-Location -LiteralPath 'C:\\work''; Start-Process calc; '''")
  })
})
