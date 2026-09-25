import { InstallationVersion } from "../installation/version"

export type Registration = { origin: string; clientId: string }
export type Credential = {
  access: string
  refresh: string
  expires: number
  clientId: string
  enterpriseUrl: string
}

/** Shared transport for Vector's legacy and native device-sign-in adapters. */
export function createGitlabOAuth(dependencies?: {
  fetch?: typeof fetch
  now?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}) {
  const fetcher = dependencies?.fetch ?? fetch
  const now = dependencies?.now ?? Date.now
  const sleep = dependencies?.sleep ?? delay
  const request = async (
    registration: Registration,
    route: string,
    body: Record<string, string>,
    signal: AbortSignal,
  ) => {
    requireRegistration(registration)
    signal.throwIfAborted()
    const response = await fetcher(`${registration.origin}/oauth/${route}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "User-Agent": `vector/${InstallationVersion}`,
      },
      body: new URLSearchParams({ ...body, client_id: registration.clientId }),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    }).catch(() => {
      signal.throwIfAborted()
      throw new Error("Vector could not reach GitLab securely. Try signing in again.")
    })
    const value: unknown = await response.json().catch(() => undefined)
    if (!value || typeof value !== "object") throw new Error("GitLab returned an invalid authorization response.")
    return { response, value: value as Record<string, unknown> }
  }
  return {
    async authorize(registration: Registration, signal: AbortSignal) {
      const result = await request(registration, "authorize_device", { scope: "api" }, signal)
      if (!result.response.ok)
        throw new Error(
          "GitLab rejected device sign-in. Check the configured application's device grant and api scope.",
        )
      const device = result.value
      const verification = typeof device.verification_uri === "string" ? URL.parse(device.verification_uri) : null
      if (
        !verification ||
        verification.origin !== registration.origin ||
        verification.pathname !== "/oauth/device" ||
        verification.search ||
        verification.hash ||
        verification.username ||
        verification.password ||
        typeof device.device_code !== "string" ||
        !device.device_code ||
        device.device_code.length > 4096 ||
        typeof device.user_code !== "string" ||
        !/^[A-Za-z0-9-]{4,32}$/.test(device.user_code) ||
        !positiveSeconds(device.expires_in) ||
        (device.interval !== undefined && !positiveSeconds(device.interval))
      )
        throw new Error("GitLab returned an invalid device authorization response.")
      const deviceCode = device.device_code
      const expires = now() + Math.min(device.expires_in, 900) * 1000
      let interval = (typeof device.interval === "number" ? device.interval : 5) * 1000
      let completion: Promise<Credential> | undefined
      return {
        url: verification.href,
        instructions: `Enter code: ${device.user_code}. Authorize Vector with your GitLab account.`,
        complete() {
          completion ??= (async () => {
            while (now() < expires) {
              await sleep(Math.min(interval, expires - now()), signal)
              signal.throwIfAborted()
              if (now() >= expires) break
              const result = await request(
                registration,
                "token",
                { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode },
                signal,
              )
              if (result.response.ok) return credential(registration, result.value, now())
              if (result.value.error === "authorization_pending") continue
              if (result.value.error === "slow_down") {
                interval += 5000
                continue
              }
              if (result.value.error === "access_denied") throw new Error("GitLab sign-in was declined.")
              if (result.value.error === "expired_token") break
              throw new Error("GitLab device sign-in failed. Start sign-in again.")
            }
            throw new Error("The GitLab sign-in code expired. Start sign-in again.")
          })()
          return completion
        },
      }
    },
    async refresh(registration: Registration, refresh: string, signal: AbortSignal) {
      if (!refresh) throw new Error("Your GitLab sign-in expired. Sign in again to continue.")
      const result = await request(
        registration,
        "token",
        { grant_type: "refresh_token", refresh_token: refresh },
        signal,
      )
      if (!result.response.ok) throw new Error("Your GitLab sign-in could not be renewed. Sign in again.")
      return credential(registration, result.value, now())
    },
  }
}

function positiveSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 31_536_000
}

function credential(registration: Registration, value: Record<string, unknown>, now: number): Credential {
  if (
    typeof value.access_token !== "string" ||
    !value.access_token ||
    value.access_token.length > 16384 ||
    (value.refresh_token !== undefined &&
      (typeof value.refresh_token !== "string" || value.refresh_token.length > 16384)) ||
    !positiveSeconds(value.expires_in) ||
    (value.token_type !== undefined &&
      (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer")) ||
    (value.scope !== undefined && (typeof value.scope !== "string" || !value.scope.split(" ").includes("api")))
  )
    throw new Error("GitLab returned an invalid access token response.")
  return {
    access: value.access_token,
    refresh: typeof value.refresh_token === "string" ? value.refresh_token : "",
    expires: now + value.expires_in * 1000,
    clientId: registration.clientId,
    enterpriseUrl: registration.origin,
  }
}

function requireRegistration(registration: Registration) {
  const url = URL.parse(registration.origin)
  if (
    !url ||
    url.origin !== registration.origin ||
    url.protocol !== "https:" ||
    !/^[a-f0-9]{64}$/.test(registration.clientId)
  )
    throw new Error("Configure an HTTPS GitLab origin and your own OAuth application ID.")
}

function delay(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, milliseconds)
    signal.addEventListener("abort", abort, { once: true })
  })
}
