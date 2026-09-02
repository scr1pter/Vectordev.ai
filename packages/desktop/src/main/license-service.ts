import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { cpus, hostname, platform as osPlatform, arch } from "node:os"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { VectorLicenseStatus } from "@opencode-ai/app/license"

const execFileAsync = promisify(execFile)
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000

type StoredLicense = {
  activationToken: string
  lastValidatedAt: string
  status: VectorLicenseStatus
}

type RemoteStatus = {
  access: boolean
  state: "active" | "canceling" | "grace" | "expired" | "past_due"
  message?: string
  email: string
  expiresAt: string
  graceEndsAt?: string
  cancelAtPeriodEnd: boolean
  plan: "annual" | "monthly"
  interval: "year" | "month"
  priceUsd: number
  deviceName?: string
  devicePlatform?: string
  lastFour: string
  offlineGraceDays: number
}

type RemoteError = { error?: { code?: string; message?: string } }

export type VectorLicenseService = ReturnType<typeof createLicenseService>

const normalizeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function hardwareIdentity(userDataPath: string) {
  const platform = osPlatform()
  try {
    if (platform === "darwin") {
      const { stdout } = await execFileAsync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 2_000 })
      const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
      if (match?.[1]) return match[1]
    }
    if (platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_ComputerSystemProduct).UUID"],
        { timeout: 3_000 },
      )
      if (stdout.trim()) return stdout.trim()
    }
    if (platform === "linux") {
      const value = await readFile("/etc/machine-id", "utf8").catch(() => "")
      if (value.trim()) return value.trim()
    }
  } catch {}
  return [hostname(), platform, arch(), cpus()[0]?.model ?? "cpu", userDataPath].join("|")
}

export function createLicenseService(input: {
  userDataPath: string
  version: string
  packaged: boolean
  channel: "dev" | "beta" | "prod"
  apiUrl?: string
}) {
  const file = join(input.userDataPath, "vector-license.json")
  const api = (input.apiUrl || process.env.VECTOR_LICENSE_API_URL || "https://vectordev.ai/api/billing").replace(
    /\/$/,
    "",
  )
  let devicePromise: Promise<{ id: string; name: string; platform: string }> | undefined

  const device = () => {
    devicePromise ??= hardwareIdentity(input.userDataPath).then((raw) => ({
      id: createHash("sha256").update(`vector-device-v1\0${raw}`).digest("hex"),
      name: hostname() || "Vector computer",
      platform: `${osPlatform()}-${arch()}`,
    }))
    return devicePromise
  }

  const readStored = async () => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as StoredLicense
    } catch {
      return undefined
    }
  }

  const writeStored = async (value: StoredLicense) => {
    const temp = `${file}.tmp`
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, file)
  }

  const removeStored = async () => {
    await rm(file, { force: true }).catch(() => undefined)
  }

  const request = async <T>(path: string, init?: RequestInit) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const headers = new Headers(init?.headers)
      headers.set("content-type", "application/json")
      headers.set("x-vector-version", input.version)
      const response = await fetch(`${api}/${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      })
      const body = (await response.json().catch(() => ({}))) as T & RemoteError
      if (!response.ok) {
        const error = new Error(body.error?.message || `Vector licensing returned ${response.status}.`) as Error & {
          code?: string
          status?: number
        }
        error.code = body.error?.code
        error.status = response.status
        throw error
      }
      return body as T
    } finally {
      clearTimeout(timer)
    }
  }

  const accessible = (remote: RemoteStatus, lastValidatedAt = new Date().toISOString()): VectorLicenseStatus => ({
    ...remote,
    state: remote.state,
    lastValidatedAt,
  })

  const status = async (): Promise<VectorLicenseStatus> => {
    if (!input.packaged && input.channel === "dev") {
      return { access: true, state: "development", message: "Development builds do not require activation." }
    }
    const stored = await readStored()
    if (!stored?.activationToken) {
      try {
        const config = await request<{ available: boolean; licenseRequired?: boolean }>("config", { method: "GET" })
        if (!(config.licenseRequired ?? config.available)) {
          return {
            access: true,
            state: "beta",
            message: "Vector paid licensing is not active yet. This build remains available as a public beta.",
          }
        }
        return {
          access: false,
          state: "activation_required",
          message: "Enter the license key from your Vector purchase email.",
        }
      } catch (error) {
        return {
          access: false,
          state: "offline",
          message: `Vector could not verify licensing: ${normalizeError(error)}`,
        }
      }
    }

    try {
      const currentDevice = await device()
      const remote = await request<RemoteStatus>("status", {
        method: "POST",
        body: JSON.stringify({ activationToken: stored.activationToken, deviceId: currentDevice.id }),
      })
      const result = accessible(remote)
      await writeStored({ ...stored, lastValidatedAt: result.lastValidatedAt!, status: result })
      return result
    } catch (error) {
      const typed = error as Error & { status?: number; code?: string }
      if (typed.status && typed.status < 500) {
        return {
          ...stored.status,
          access: false,
          state:
            typed.code === "LICENSE_EXPIRED"
              ? "expired"
              : typed.code === "PAYMENT_REQUIRED"
                ? "past_due"
                : "activation_required",
          message: typed.message,
        }
      }
      const last = Date.parse(stored.lastValidatedAt)
      const expires = Date.parse(stored.status.expiresAt ?? "")
      const graceEnds = Date.parse(stored.status.graceEndsAt ?? "")
      const accessEnd = stored.status.state === "grace" && Number.isFinite(graceEnds) ? graceEnds : expires
      if (
        stored.status.access &&
        Number.isFinite(last) &&
        Date.now() - last <= OFFLINE_GRACE_MS &&
        accessEnd > Date.now()
      ) {
        return {
          ...stored.status,
          access: true,
          state: "grace",
          message: "Vector is offline. License access is temporarily using the seven-day offline grace period.",
        }
      }
      return {
        ...stored.status,
        access: false,
        state: "offline",
        message: "Connect to the internet so Vector can verify this license.",
      }
    }
  }

  const activate = async (licenseKey: string) => {
    const currentDevice = await device()
    const result = await request<{ activationToken: string; status: RemoteStatus }>("activate", {
      method: "POST",
      body: JSON.stringify({
        licenseKey: licenseKey.trim(),
        deviceId: currentDevice.id,
        deviceName: currentDevice.name,
        platform: currentDevice.platform,
      }),
    })
    const next = accessible(result.status)
    await writeStored({ activationToken: result.activationToken, lastValidatedAt: next.lastValidatedAt!, status: next })
    return next
  }

  const withActivation = async <T>(path: string, extra?: Record<string, unknown>) => {
    const stored = await readStored()
    if (!stored?.activationToken) throw new Error("Vector is not activated on this computer.")
    const currentDevice = await device()
    return request<T>(path, {
      method: "POST",
      body: JSON.stringify({ activationToken: stored.activationToken, deviceId: currentDevice.id, ...extra }),
    })
  }

  return {
    status,
    activate,
    async deactivate() {
      await withActivation<{ deactivated: boolean }>("deactivate")
      await removeStored()
      return status()
    },
    async setCancellation(cancel: boolean) {
      const remote = await withActivation<RemoteStatus>("cancel", { cancel })
      const stored = await readStored()
      const next = accessible(remote)
      if (stored) await writeStored({ ...stored, lastValidatedAt: next.lastValidatedAt!, status: next })
      return next
    },
    async openBillingPortal() {
      const result = await withActivation<{ url: string }>("portal")
      return result.url
    },
  }
}
