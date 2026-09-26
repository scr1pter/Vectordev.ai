import { InstallationVersion } from "../installation/version"

export type DeviceRegistration = {
  clientId: string
  origin: string
  devicePath: string
  tokenPath: string
  verificationPath?: string
  scope: string
}
export type OAuthToken = { access: string; refresh: string; expires: number; clientId: string; enterpriseUrl: string }

/** No redirects or response text can carry authorization secrets to another host or into an error. */
export async function oauthJSON(
  url: string,
  body: Record<string, string>,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const endpoint = new URL(url)
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash)
    throw new Error("OAuth requires a secure provider endpoint.")
  signal.throwIfAborted()
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": `vector/${InstallationVersion}`,
    },
    body: new URLSearchParams(body),
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  }).catch(() => {
    signal.throwIfAborted()
    throw new Error("Vector could not reach the authorization provider securely. Try signing in again.")
  })
  const reader = response.body?.getReader()
  if (!reader) throw new Error("The authorization provider returned an empty response.")
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > 65_536) throw new Error("The authorization response exceeded its size limit.")
      chunks.push(result.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const value: unknown = await new Response(bytes).json().catch(() => undefined)
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The authorization provider returned an invalid response.")
  return { ok: response.ok, value: value as Record<string, unknown> }
}

export function oauthToken(
  registration: Pick<DeviceRegistration, "clientId" | "origin">,
  value: Record<string, unknown>,
  now: number,
  nonExpiring = false,
): OAuthToken {
  if (
    typeof value.access_token !== "string" ||
    !value.access_token ||
    value.access_token.length > 16_384 ||
    (value.refresh_token !== undefined &&
      (typeof value.refresh_token !== "string" || value.refresh_token.length > 16_384)) ||
    (!positiveSeconds(value.expires_in) && !(nonExpiring && value.expires_in === undefined)) ||
    (value.token_type !== undefined &&
      (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer"))
  )
    throw new Error("The authorization provider returned an invalid token.")
  return {
    access: value.access_token,
    refresh: typeof value.refresh_token === "string" ? value.refresh_token : "",
    expires: positiveSeconds(value.expires_in) ? now + value.expires_in * 1000 : Number.MAX_SAFE_INTEGER,
    clientId: registration.clientId,
    enterpriseUrl: registration.origin,
  }
}

export function createDeviceOAuth(dependencies?: {
  fetch?: typeof fetch
  now?: () => number
  sleep?: typeof oauthDelay
}) {
  const now = dependencies?.now ?? Date.now
  const request = (
    registration: DeviceRegistration,
    path: string,
    body: Record<string, string>,
    signal: AbortSignal,
  ) => {
    requireDeviceRegistration(registration)
    return oauthJSON(
      `${registration.origin}${path}`,
      { ...body, client_id: registration.clientId },
      signal,
      dependencies?.fetch,
    )
  }
  return {
    async authorize(registration: DeviceRegistration, signal: AbortSignal, nonExpiring = false) {
      const result = await request(registration, registration.devicePath, { scope: registration.scope }, signal)
      if (!result.ok)
        throw new Error("Device sign-in was rejected. Check Vector's application registration and approved scopes.")
      const device = result.value
      const verification = typeof device.verification_uri === "string" ? URL.parse(device.verification_uri) : null
      if (
        !verification ||
        verification.origin !== registration.origin ||
        (registration.verificationPath !== undefined && verification.pathname !== registration.verificationPath) ||
        verification.username ||
        verification.password ||
        verification.search ||
        verification.hash ||
        typeof device.device_code !== "string" ||
        !device.device_code ||
        device.device_code.length > 4096 ||
        typeof device.user_code !== "string" ||
        !/^[A-Za-z0-9-]{4,32}$/.test(device.user_code) ||
        !positiveSeconds(device.expires_in) ||
        (device.interval !== undefined && !positiveSeconds(device.interval))
      )
        throw new Error("The provider returned an invalid device authorization response.")
      const deviceCode = device.device_code
      const expires = now() + Math.min(device.expires_in, 900) * 1000
      let interval = (typeof device.interval === "number" ? device.interval : 5) * 1000
      let completion: Promise<OAuthToken> | undefined
      return {
        url: verification.href,
        instructions: `Enter code: ${device.user_code}. Authorize Vector with your account.`,
        complete() {
          completion ??= (async () => {
            while (now() < expires) {
              await (dependencies?.sleep ?? oauthDelay)(Math.min(interval, expires - now()), signal)
              signal.throwIfAborted()
              if (now() >= expires) break
              const token = await request(
                registration,
                registration.tokenPath,
                { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode },
                signal,
              )
              // GitHub returns pending/slow_down errors with HTTP 200.
              if (token.ok && token.value.access_token) return oauthToken(registration, token.value, now(), nonExpiring)
              if (token.value.error === "authorization_pending") continue
              if (token.value.error === "slow_down") {
                interval = Math.max(
                  interval + 5000,
                  positiveSeconds(token.value.interval) ? token.value.interval * 1000 : 0,
                )
                continue
              }
              if (token.value.error === "access_denied") throw new Error("Device sign-in was declined.")
              if (token.value.error === "expired_token") break
              throw new Error("Device sign-in failed. Start sign-in again.")
            }
            throw new Error("The device sign-in code expired. Start sign-in again.")
          })()
          return completion
        },
      }
    },
    async refresh(registration: DeviceRegistration, refresh: string, signal: AbortSignal) {
      if (!refresh) throw new Error("Your provider sign-in expired. Sign in again.")
      const result = await request(
        registration,
        registration.tokenPath,
        { grant_type: "refresh_token", refresh_token: refresh },
        signal,
      )
      if (!result.ok || result.value.error)
        throw new Error("Your provider sign-in could not be renewed. Sign in again.")
      return oauthToken(registration, { refresh_token: refresh, ...result.value }, now())
    },
  }
}

function requireDeviceRegistration(value: DeviceRegistration) {
  const origin = URL.parse(value.origin)
  if (
    !origin ||
    origin.origin !== value.origin ||
    origin.protocol !== "https:" ||
    !/^[A-Za-z0-9._-]{8,256}$/.test(value.clientId) ||
    [value.devicePath, value.tokenPath, ...(value.verificationPath ? [value.verificationPath] : [])].some(
      (path) => !/^\/[A-Za-z0-9/_-]+$/.test(path),
    )
  )
    throw new Error("Configure Vector's approved provider application before signing in.")
}
function positiveSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 31_536_000
}
export function oauthDelay(milliseconds: number, signal: AbortSignal) {
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
