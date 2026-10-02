// These values are deliberately exposed to browser bundles. Never promote a
// management, service-role, or user-session token into a VITE_ variable.
export function isSupabasePublicKey(value: string): boolean {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return true
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return false
  try {
    const payload: unknown = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString("utf8"))
    return (
      !!payload &&
      typeof payload === "object" &&
      Reflect.get(payload, "iss") === "supabase" &&
      Reflect.get(payload, "role") === "anon" &&
      typeof Reflect.get(payload, "ref") === "string" &&
      Reflect.get(payload, "ref").length > 0
    )
  } catch {
    return false
  }
}
