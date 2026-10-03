import path from "node:path"

export function environment(command: string, env: Record<string, string | undefined> = process.env) {
  if (path.win32.basename(command).toLowerCase() !== "powershell.exe") return env
  // PowerShell 7 only repairs PSModulePath when it directly starts Windows PowerShell.
  // Through Vector/Bun, rebuild native paths for internal installers and archive extraction.
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"))
}

export * as WindowsPowerShell from "./windows-powershell"
