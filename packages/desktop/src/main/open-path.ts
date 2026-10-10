export const OPEN_PATH_APPLICATIONS = [
  "vscode",
  "cursor",
  "zed",
  "textmate",
  "antigravity",
  "terminal",
  "iterm2",
  "ghostty",
  "warp",
  "xcode",
  "android-studio",
  "powershell",
  "sublime-text",
] as const

export type OpenPathApplication = (typeof OPEN_PATH_APPLICATIONS)[number]

const commands: Record<OpenPathApplication, Partial<Record<NodeJS.Platform, string>>> = {
  vscode: { darwin: "Visual Studio Code", win32: "code", linux: "code" },
  cursor: { darwin: "Cursor", win32: "cursor", linux: "cursor" },
  zed: { darwin: "Zed", win32: "zed", linux: "zed" },
  textmate: { darwin: "TextMate" },
  antigravity: { darwin: "Antigravity" },
  terminal: { darwin: "Terminal" },
  iterm2: { darwin: "iTerm" },
  ghostty: { darwin: "Ghostty" },
  warp: { darwin: "Warp" },
  xcode: { darwin: "Xcode" },
  "android-studio": { darwin: "Android Studio" },
  powershell: { win32: "powershell" },
  "sublime-text": { darwin: "Sublime Text", win32: "Sublime Text", linux: "Sublime Text" },
}

export function requireOpenPathApplication(value: unknown) {
  if (value === undefined) return
  if (typeof value === "string" && OPEN_PATH_APPLICATIONS.some((application) => application === value)) {
    return value as OpenPathApplication
  }
  throw new Error("Vector rejected an unsupported application.")
}

export function requireOpenPathDirectory(value: unknown, isDirectory: boolean) {
  if (typeof value === "string" && value.length > 0 && isDirectory) return value
  throw new Error("Vector can only open an existing directory.")
}

export function openPathCommand(
  application: OpenPathApplication,
  platform: NodeJS.Platform,
  resolvedWindowsPath?: string | null,
) {
  const configured = commands[application][platform]
  if (!configured) throw new Error(`Vector cannot open paths in ${application} on this platform.`)
  if (platform !== "win32") return configured
  if (!resolvedWindowsPath || !/\.exe$/i.test(resolvedWindowsPath)) {
    throw new Error(`Vector could not find a safe executable for ${application}.`)
  }
  return resolvedWindowsPath
}

export function openPathApplication(value: string | undefined): OpenPathApplication | undefined {
  if (!value) return
  return {
    "Visual Studio Code": "vscode",
    code: "vscode",
    Cursor: "cursor",
    cursor: "cursor",
    Zed: "zed",
    zed: "zed",
    TextMate: "textmate",
    Antigravity: "antigravity",
    Terminal: "terminal",
    iTerm: "iterm2",
    Ghostty: "ghostty",
    Warp: "warp",
    Xcode: "xcode",
    "Android Studio": "android-studio",
    powershell: "powershell",
    "Sublime Text": "sublime-text",
  }[value] as OpenPathApplication | undefined
}

export function openPathApplicationCommand(application: OpenPathApplication, platform: NodeJS.Platform) {
  return commands[application][platform]
}

export function openPathArguments(application: OpenPathApplication, platform: NodeJS.Platform, path: string) {
  if (application !== "powershell" || platform !== "win32") return [path]
  const script = `Set-Location -LiteralPath '${path.replaceAll("'", "''")}'`
  return ["-NoExit", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
}
