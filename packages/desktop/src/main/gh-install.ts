// Which command actually installs the GitHub CLI on THIS machine.
//
// Vector used to hand out one command per platform: `brew install gh` on macOS,
// `sudo apt install gh` on Linux. Both are wrong often enough to matter — a Mac
// without Homebrew answers "command not found", and `gh` is not in Debian's or
// Ubuntu's default repositories at all, so apt answers "Unable to locate
// package". Telling someone to run a command that cannot work is worse than
// telling them nothing, because they assume the failure is theirs.
//
// Pure so the choice can be tested without a machine that has any of these.

export const GH_DOWNLOAD_URL = "https://cli.github.com"

// Package managers Vector looks for, in the order it prefers them.
export const GH_PACKAGE_MANAGERS = [
  "brew",
  "port",
  "winget",
  "scoop",
  "choco",
  "dnf",
  "pacman",
  "zypper",
  "apt-get",
  "snap",
] as const

export type GhPackageManager = (typeof GH_PACKAGE_MANAGERS)[number]

export type GhInstallHint = {
  // Absent when nothing on the machine can install it without adding a
  // repository first — better a link than a command that fails.
  command?: string
  url: string
  detail: string
}

const MAC_ORDER: GhPackageManager[] = ["brew", "port"]
const WINDOWS_ORDER: GhPackageManager[] = ["winget", "scoop", "choco"]
// apt-get is deliberately absent: gh is not in Debian or Ubuntu's own
// repositories, and the official route adds GitHub's apt source first — four
// commands with a keyring, which is a link's job rather than a copy button's.
const LINUX_ORDER: GhPackageManager[] = ["dnf", "pacman", "zypper", "snap"]

const COMMANDS: Record<GhPackageManager, string> = {
  brew: "brew install gh",
  port: "sudo port install gh",
  winget: "winget install --id GitHub.cli -e",
  scoop: "scoop install gh",
  choco: "choco install gh -y",
  dnf: "sudo dnf install gh",
  pacman: "sudo pacman -S github-cli",
  zypper: "sudo zypper install gh",
  "apt-get": "sudo apt install gh",
  snap: "sudo snap install gh",
}

function orderFor(platform: NodeJS.Platform) {
  if (platform === "darwin") return MAC_ORDER
  if (platform === "win32") return WINDOWS_ORDER
  return LINUX_ORDER
}

function fallbackDetail(platform: NodeJS.Platform) {
  if (platform === "darwin") {
    return "No package manager Vector recognises is installed, so there is no single command to run. Download the macOS installer from cli.github.com."
  }
  if (platform === "win32") {
    return "No package manager Vector recognises is installed. Download the Windows installer from cli.github.com."
  }
  return "gh is not in the default repositories on this distribution. cli.github.com has the packages and the one-time repository setup."
}

export function ghInstallHint(
  platform: NodeJS.Platform,
  available: Partial<Record<GhPackageManager, boolean>>,
): GhInstallHint {
  const manager = orderFor(platform).find((candidate) => available[candidate])
  if (!manager) return { url: GH_DOWNLOAD_URL, detail: fallbackDetail(platform) }
  return {
    command: COMMANDS[manager],
    url: GH_DOWNLOAD_URL,
    detail: `Installs the GitHub CLI with ${manager}, which is already on this computer.`,
  }
}
