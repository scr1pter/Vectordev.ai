import * as passwords from "../auth/password"

export async function register(email: string, secret: string) {
  return { email, digest: await passwords.hashPassword(secret, email) }
}
