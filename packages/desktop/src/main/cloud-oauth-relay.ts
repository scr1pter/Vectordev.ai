import {
  constants,
  createHash,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto"
import type { CloudProviderId } from "./cloud-provider-token"

export function createCloudOAuthRelay() {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 })
  return {
    state: `${randomBytes(32).toString("base64url")}.v1.${Buffer.from(JSON.stringify(keys.publicKey.export({ format: "jwk" }))).toString("base64url")}`,
    privateKey: keys.privateKey,
  }
}

export function matchesCloudOAuthState(expected: string, returned: string) {
  return timingSafeEqual(createHash("sha256").update(expected).digest(), createHash("sha256").update(returned).digest())
}

export function readCloudOAuthCallback(
  provider: CloudProviderId,
  url: URL,
  flow: { state: string; privateKey?: KeyObject },
) {
  if (!matchesCloudOAuthState(flow.state, url.searchParams.get("state") ?? "")) {
    throw new Error("The OAuth security state did not match. Start the connection again.")
  }
  const error = url.searchParams.get("error")
  if (error) throw new Error(error)
  if (provider === "supabase") {
    const code = url.searchParams.get("code")
    if (!code) throw new Error("Supabase did not return an authorization code.")
    return code
  }
  // Custom URL handlers are not exclusive. Only this pending desktop flow can
  // decrypt the Vercel code or Netlify token; there is no plaintext fallback.
  // RSA wraps only the AES key so provider credentials may exceed OAEP limits.
  const encrypted = url.searchParams.get("encrypted") ?? ""
  const parts = encrypted.split(".")
  if (
    encrypted.length > 24_000 ||
    parts.length !== 4 ||
    parts[0] !== "v1" ||
    !flow.privateKey ||
    parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  ) {
    throw new Error(`${provider} did not return a secure authorization result. Update Vector and start again.`)
  }
  const iv = Buffer.from(parts[2], "base64url")
  const ciphertext = Buffer.from(parts[3], "base64url")
  if (iv.length !== 12 || ciphertext.length < 17 || ciphertext.length > 16_400) {
    throw new Error("The secure authorization envelope is invalid.")
  }
  const key = privateDecrypt(
    { key: flow.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(parts[1], "base64url"),
  )
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAAD(Buffer.from(`${provider}\n${flow.state}`))
  decipher.setAuthTag(ciphertext.subarray(-16))
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString("utf8")
}

export function cloudOAuthAuthorizeUrl(provider: CloudProviderId, value: string) {
  const url = new URL(value)
  const origins = {
    vercel: "https://vercel.com",
    netlify: "https://app.netlify.com",
    supabase: "https://api.supabase.com",
  }
  if (url.origin !== origins[provider] || url.username || url.password) {
    throw new Error("The provider returned an invalid authorization URL.")
  }
  return url.toString()
}
