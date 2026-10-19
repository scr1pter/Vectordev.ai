const bucket = process.env.UPLOAD_BUCKET ?? "uploads"

export async function storeObject(key: string, bytes: Uint8Array) {
  return { bucket, key, size: bytes.length }
}
