import whichPkg from "which"
import path from "path"
import { Global } from "../global"

export function which(cmd: string, env?: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform) {
  const base = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? ""
  const full = base ? base + path.delimiter + Global.Path.bin : Global.Path.bin
  const pathExt = env?.PATHEXT ?? env?.PathExt ?? process.env.PATHEXT ?? process.env.PathExt
  if (platform === "win32" && !/[\\/]/.test(cmd)) return windows(cmd, full, pathExt)
  const result = whichPkg.sync(cmd, { nothrow: true, path: full, pathExt })
  return typeof result === "string" ? result : null
}

// Windows looks for a bare name in the current folder before PATH, and resolves a relative PATH entry against it.
// Vector runs from inside the repository it works on (the CLI changes into it), so a pwsh.exe or git.cmd committed to
// a repository's root would be found in place of the installed one. There a bare name comes from an absolute PATH
// entry only, which is how `which` reads a name that holds a folder.
function windows(cmd: string, dirs: string, pathExt: string | undefined) {
  return dirs
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => path.isAbsolute(dir))
    .reduce<string | null>((found, dir) => {
      if (found) return found
      const result = whichPkg.sync(path.join(dir, cmd), { nothrow: true, pathExt })
      return typeof result === "string" ? result : null
    }, null)
}
