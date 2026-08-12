import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js"

export type PlatformConfig = {
  auth: {
    available: boolean
    url?: string
    publishableKey?: string
    providers: Array<"github" | "google">
  }
  services: { apiPlatform: boolean; cloudAgents: boolean; billing: boolean }
  cloudModel: string | null
  limits: {
    activeCloudAgents: number
    cloudAgentLaunches30Days: number
    cloudAgentTurns30Days: number
    apiExecutionsDaily: number
  }
  plans: Array<{ id: "monthly" | "annual"; priceUsd: number; interval: string; graceDays: number }>
}

let configPromise: Promise<PlatformConfig> | undefined
let client: SupabaseClient | undefined

export async function platformConfig() {
  configPromise ||= fetch("/api/platform/config", { headers: { accept: "application/json" } }).then(
    async (response) => {
      const raw = await response.text()
      let payload: Partial<PlatformConfig> & { error?: { message?: string } }
      try {
        payload = JSON.parse(raw) as Partial<PlatformConfig> & { error?: { message?: string } }
      } catch {
        throw new Error("This deployment has not connected its Vector account service yet.")
      }
      if (!response.ok) throw new Error(payload.error?.message || "Vector accounts are unavailable.")
      if (!payload.auth || !payload.services || !payload.limits || !payload.plans) {
        throw new Error("This deployment has not connected its Vector account service yet.")
      }
      return payload as PlatformConfig
    },
  )
  return configPromise
}

export async function platformAuth() {
  if (client) return client
  const config = await platformConfig()
  if (!config.auth.available || !config.auth.url || !config.auth.publishableKey) {
    throw new Error("Vector accounts are not configured on this deployment.")
  }
  client = createClient(config.auth.url, config.auth.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  })
  return client
}

type ApiErrorPayload = {
  error?: { message?: string; code?: string }
}

export async function apiFetch<T extends Record<string, unknown> = Record<string, unknown>>(
  path: string,
  session: Session,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set("accept", "application/json")
  headers.set("authorization", `Bearer ${session.access_token}`)
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json")
  const response = await fetch(path, { ...init, headers })
  const raw = await response.text()
  let payload: Record<string, unknown> & ApiErrorPayload = {}
  try {
    payload = raw ? (JSON.parse(raw) as Record<string, unknown> & ApiErrorPayload) : {}
  } catch {
    if (!response.ok) throw new Error(`Vector's service is unavailable (${response.status}).`)
    throw new Error("Vector's service returned an invalid response.")
  }
  if (!response.ok) {
    const error = new Error(payload.error?.message || `Vector request failed (${response.status}).`) as Error & {
      code?: string
      status?: number
    }
    error.code = payload.error?.code
    error.status = response.status
    throw error
  }
  return payload as T
}

export function formatDate(value?: string | null) {
  if (!value) return "Not available"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
}

export function formatDuration(start?: string | null, end?: string | null) {
  if (!start) return "Not started"
  const milliseconds = Math.max(0, new Date(end || Date.now()).getTime() - new Date(start).getTime())
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
