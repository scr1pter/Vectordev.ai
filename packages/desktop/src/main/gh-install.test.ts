import { describe, expect, test } from "bun:test"

import { GH_DOWNLOAD_URL, ghInstallHint } from "./gh-install"

describe("choosing how to install the GitHub CLI", () => {
  test("macOS uses Homebrew when it is actually installed", () => {
    const hint = ghInstallHint("darwin", { brew: true })
    expect(hint.command).toBe("brew install gh")
    expect(hint.detail).toContain("brew")
  })

  test("macOS without Homebrew offers the download instead of a command that cannot run", () => {
    // The reported bug: a Mac with no Homebrew was told to run `brew install
    // gh`, which answers "command not found".
    const hint = ghInstallHint("darwin", {})
    expect(hint.command).toBeUndefined()
    expect(hint.url).toBe(GH_DOWNLOAD_URL)
    expect(hint.detail).toContain("no single command")
  })

  test("macOS falls back to MacPorts before giving up", () => {
    expect(ghInstallHint("darwin", { port: true }).command).toBe("sudo port install gh")
  })

  test("Homebrew wins over MacPorts when both are present", () => {
    expect(ghInstallHint("darwin", { brew: true, port: true }).command).toBe("brew install gh")
  })

  test("Windows prefers winget and pins an exact id", () => {
    // Without -e the id is a prefix match and can resolve to another package.
    expect(ghInstallHint("win32", { winget: true }).command).toBe("winget install --id GitHub.cli -e")
    expect(ghInstallHint("win32", { scoop: true }).command).toBe("scoop install gh")
    expect(ghInstallHint("win32", { choco: true }).command).toBe("choco install gh -y")
  })

  test("distributions that really ship gh get their own command", () => {
    expect(ghInstallHint("linux", { dnf: true }).command).toBe("sudo dnf install gh")
    expect(ghInstallHint("linux", { pacman: true }).command).toBe("sudo pacman -S github-cli")
    expect(ghInstallHint("linux", { zypper: true }).command).toBe("sudo zypper install gh")
    expect(ghInstallHint("linux", { snap: true }).command).toBe("sudo snap install gh")
  })

  test("apt alone never produces a command", () => {
    // gh is not in Debian's or Ubuntu's default repositories, so `sudo apt
    // install gh` answers "Unable to locate package". The official route adds
    // GitHub's apt source first, which belongs behind a link.
    const hint = ghInstallHint("linux", { "apt-get": true })
    expect(hint.command).toBeUndefined()
    expect(hint.detail).toContain("default repositories")
    expect(hint.url).toBe(GH_DOWNLOAD_URL)
  })

  test("apt plus snap uses snap, because that one works", () => {
    expect(ghInstallHint("linux", { "apt-get": true, snap: true }).command).toBe("sudo snap install gh")
  })

  test("every hint carries the download link, command or not", () => {
    expect(ghInstallHint("darwin", { brew: true }).url).toBe(GH_DOWNLOAD_URL)
    expect(ghInstallHint("linux", {}).url).toBe(GH_DOWNLOAD_URL)
  })
})
