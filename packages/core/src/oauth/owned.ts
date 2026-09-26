import { InstallationVersion } from "../installation/version"

/** The credential is resolved only after the destination is checked, before every request. */
export function ownedOAuthFetch(
  origin: string,
  access: () => Promise<string>,
  fetcher: typeof fetch = fetch,
): typeof fetch {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== origin || url.username || url.password)
        throw new Error("This OAuth credential cannot be sent to a different provider origin.")
      const headers = new Headers(input instanceof Request ? input.headers : undefined)
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
      headers.set("authorization", `Bearer ${await access()}`)
      headers.set("user-agent", `vector/${InstallationVersion}`)
      headers.delete("x-api-key")
      return fetcher(input, { ...init, headers, redirect: "error" })
    },
    { preconnect: fetcher.preconnect },
  )
}
