import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

function runtimeVaultKey(): Buffer {
  const encoded = process.env.VECTOR_CREDENTIAL_KEY?.trim()
  if (!encoded) throw new Error("Vector's local credential vault is unavailable. Restart Vector and try again.")
  const key = Buffer.from(encoded, "base64")
  if (key.byteLength !== 32) throw new Error("Vector's local credential vault is invalid.")
  return key
}

export function encryptCloudCredential(value: string, key = runtimeVaultKey()): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`
}

export function decryptCloudCredential(value: string, key = runtimeVaultKey()): string {
  const [version, ivValue, tagValue, encryptedValue] = value.split(".")
  if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) {
    throw new Error("The stored cloud credential is invalid.")
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"))
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8")
}
