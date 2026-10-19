export const PASSWORD_MIN_LENGTH = 12

export async function hashPassword(password: string, salt: string) {
  if (password.length < PASSWORD_MIN_LENGTH) throw new Error("too short")
  const data = new TextEncoder().encode(`${salt}:${password}`)
  return Buffer.from(await crypto.subtle.digest("SHA-256", data)).toString("hex")
}
