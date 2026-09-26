import { authorizeLoopback } from "./loopback"
import { poeOAuthConfiguration } from "../provider-policy"

/** Poe exchanges the PKCE code for a delegated API key, optionally with an expiry. */
export function createPoeOAuth(dependencies?: { fetch?: typeof fetch; timeoutMs?: number; now?: () => number }) {
  return {
    async authorize(registration: NonNullable<ReturnType<typeof poeOAuthConfiguration>>, signal: AbortSignal) {
      if (registration.origin !== "https://poe.com" || registration.scope !== "apikey:create")
        throw new Error("Use Vector's registered Poe client and API-key scope.")
      const flow = await authorizeLoopback(
        { ...registration, authorizeUrl: "https://poe.com/oauth/authorize", tokenUrl: "https://api.poe.com/token" },
        signal,
        dependencies,
      )
      const completed = flow.complete().then((value) => {
        if (
          value.api_key_expires_in !== null &&
          (typeof value.api_key_expires_in !== "number" ||
            !Number.isSafeInteger(value.api_key_expires_in) ||
            value.api_key_expires_in <= 0)
        )
          throw new Error("Poe returned an invalid API-key expiry.")
        const expires =
          value.api_key_expires_in === null
            ? Number.MAX_SAFE_INTEGER
            : (dependencies?.now?.() ?? Date.now()) + Number(value.api_key_expires_in) * 1000
        if (
          typeof value.api_key !== "string" ||
          !value.api_key ||
          value.api_key.length > 16_384 ||
          !Number.isSafeInteger(expires)
        )
          throw new Error("Poe returned an invalid delegated API key.")
        return {
          access: value.api_key,
          refresh: "",
          expires,
          clientId: registration.clientId,
          enterpriseUrl: registration.origin,
        }
      })
      void completed.catch(() => undefined)
      return { ...flow, complete: () => completed }
    },
  }
}
