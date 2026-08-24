// The predicate behind Vector's promise that the browser never types into a
// credential field. It lives in its own module, free of electron imports, so it
// can be tested directly — browser-agent.ts pulls in WebContentsView at module
// load, which makes it unimportable from a test.
//
// It is also stringified into the injected page scripts, so it must stay a
// self-contained function with no imports or closure references.
export function isCredentialField(field: {
  type?: string | null
  autocomplete?: string | null
  name?: string | null
  id?: string | null
  textSecurity?: string | null
}) {
  if ((field.type || "").toLowerCase() === "password") return true
  // A masked field is a credential field whatever its type attribute claims.
  // The common hand-rolled login input is type="text" plus -webkit-text-security,
  // which the attribute checks below cannot see.
  if ((field.textSecurity || "none").toLowerCase() !== "none") return true
  if (/one-time-code|current-password|new-password|cc-number|cc-csc/.test((field.autocomplete || "").toLowerCase())) {
    return true
  }
  return /pass(word|wd)|pwd|otp|totp|mfa|2fa|one-?time|verification-?code|security-?code|card-?number|cc-?num|cvv|cvc|csc/.test(
    `${field.name || ""} ${field.id || ""}`.toLowerCase(),
  )
}
