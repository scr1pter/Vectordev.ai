import { createHmac, timingSafeEqual } from "node:crypto"
import { ApiError, type ApiRequest } from "./http.js"
import { hashSecret, platformAdmin } from "./platform.js"

type ComputerToken = { userId: string; runId: string; deviceId: string; expiresAt: number }

function companionSecret() {
  const secret = process.env.VECTOR_PLATFORM_SECRET?.trim()
  if (!secret || secret.length < 32) {
    throw new ApiError(503, "COMPANION_NOT_CONFIGURED", "Vector's desktop companion is not configured.")
  }
  return secret
}

function signature(payload: string) {
  return createHmac("sha256", companionSecret()).update(payload).digest("base64url")
}

export function createComputerToken(input: Omit<ComputerToken, "expiresAt">) {
  const payload = Buffer.from(JSON.stringify({ ...input, expiresAt: Date.now() + 24 * 60 * 60 * 1_000 })).toString(
    "base64url",
  )
  return `${payload}.${signature(payload)}`
}

export function verifyComputerToken(value: string | undefined): ComputerToken {
  const [payload, supplied] = (value || "").split(".")
  const expected = payload ? Buffer.from(signature(payload)) : Buffer.alloc(0)
  const received = supplied ? Buffer.from(supplied) : Buffer.alloc(0)
  if (!payload || !supplied || expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new ApiError(401, "COMPANION_TOKEN_INVALID", "This computer-control session is invalid.")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    throw new ApiError(401, "COMPANION_TOKEN_INVALID", "This computer-control session is invalid.")
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof Reflect.get(parsed, "userId") !== "string" ||
    typeof Reflect.get(parsed, "runId") !== "string" ||
    typeof Reflect.get(parsed, "deviceId") !== "string" ||
    typeof Reflect.get(parsed, "expiresAt") !== "number" ||
    Reflect.get(parsed, "expiresAt") <= Date.now()
  ) {
    throw new ApiError(401, "COMPANION_TOKEN_EXPIRED", "This computer-control session has expired.")
  }
  return {
    userId: Reflect.get(parsed, "userId"),
    runId: Reflect.get(parsed, "runId"),
    deviceId: Reflect.get(parsed, "deviceId"),
    expiresAt: Reflect.get(parsed, "expiresAt"),
  }
}

export async function requireCompanionDevice(request: ApiRequest) {
  const authorization = request.headers.authorization || ""
  const match = /^Device ([^.]+)\.(.+)$/.exec(authorization)
  if (!match) throw new ApiError(401, "DEVICE_AUTH_REQUIRED", "Vector desktop must authenticate this request.")
  const [, id, secret] = match
  const { data, error } = await platformAdmin()
    .from("vector_companion_devices")
    .select("id,user_id,name,platform,permissions,status,last_seen_at")
    .eq("id", id)
    .eq("secret_hash", hashSecret(secret!))
    .eq("status", "connected")
    .maybeSingle()
  if (error || !data) throw new ApiError(401, "DEVICE_AUTH_INVALID", "This Vector desktop pairing is no longer valid.")
  return data as {
    id: string
    user_id: string
    name: string
    platform: string
    permissions: string[]
    status: string
    last_seen_at: string | null
  }
}
