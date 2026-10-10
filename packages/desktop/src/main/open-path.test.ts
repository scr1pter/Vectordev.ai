import { describe, expect, test } from "bun:test"
import {
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
    expect(() => requireOpenPathDirectory("/tmp/tool", false)).toThrow("existing directory")
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
