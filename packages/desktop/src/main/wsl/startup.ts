export function wslServerIdsToStartOnInitialize(servers: { id: string }[]) {
  return servers.map((server) => server.id)
}

export function expectVectorVersion(installed: string | null, expected: string, distro = "Debian") {
  if (installed === expected) return
  throw new Error(
    `Update Vector in ${distro} before starting this server: installed ${installed ?? "no version"}; desktop requires ${expected}. Choose Install Vector or Update Vector in server settings.`,
  )
}

export const pendingRestartAfterWslInstall = (runtime: { available: boolean }) => !runtime.available

export async function pollWslHealth(check: () => Promise<boolean>, signal: AbortSignal, interval = 100) {
  while (!signal.aborted) {
    if (await check()) return
    await abortableDelay(interval, signal)
  }
}

function abortableDelay(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timeout = setTimeout(done, duration)
    signal.addEventListener("abort", done, { once: true })
  })
}

export function wslReinstallMessage(distro: string) {
  return `This WSL server needs Vector installed again in ${distro}. Install Linux curl, tar and SHA-256 tools, then choose Install Vector in server settings.`
}

export async function requireWslAuthentication(url: string, distro: string, stop: () => void, signal: AbortSignal) {
  const response = await fetch(new URL("/config", url), {
    signal,
    redirect: "manual",
  }).catch((error: unknown) => {
    stop()
    throw error
  })
  if (response.status === 401) return
  stop()
  throw new Error(
    `The Vector engine in ${distro} is not enforcing authentication. Reinstall Vector from server settings.`,
  )
}

export const wslSignInMessage = "Sign in to your Vector account in the desktop app before starting a WSL server."
