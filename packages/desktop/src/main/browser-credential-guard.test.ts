import { describe, expect, test } from "bun:test"
import { isCredentialField } from "./browser-credential-field"

// The landing page states plainly that the browser "will not type into a
// password, one-time-code, or card field". The guard used to be reachable only
// through the typing path, so the agent's own `press` command walked around it.
// These pin the predicate every input path now shares.
describe("isCredentialField", () => {
  test("a password input is refused", () => {
    expect(isCredentialField({ type: "password" })).toBe(true)
    expect(isCredentialField({ type: "PASSWORD" })).toBe(true)
  })

  test("a masked field is refused even when it claims to be text", () => {
    // The common hand-rolled login box: type="text" with the characters masked
    // by CSS, which no attribute check can see.
    expect(isCredentialField({ type: "text", textSecurity: "disc" })).toBe(true)
    expect(isCredentialField({ type: "text", textSecurity: "none" })).toBe(false)
  })

  test("autocomplete hints for codes and cards are refused", () => {
    for (const hint of ["one-time-code", "current-password", "new-password", "cc-number", "cc-csc"]) {
      expect(isCredentialField({ type: "text", autocomplete: hint })).toBe(true)
    }
  })

  test("credential-shaped names and ids are refused whatever the type says", () => {
    for (const name of ["password", "passwd", "pwd", "otp", "totp", "mfa", "2fa", "cvv", "cvc", "card-number"]) {
      expect(isCredentialField({ type: "text", name })).toBe(true)
      expect(isCredentialField({ type: "text", id: name })).toBe(true)
    }
  })

  test("an ordinary field is allowed, so the guard does not block real work", () => {
    expect(isCredentialField({ type: "text", name: "email", id: "email" })).toBe(false)
    expect(isCredentialField({ type: "search", name: "q" })).toBe(false)
    expect(isCredentialField({})).toBe(false)
  })
})
