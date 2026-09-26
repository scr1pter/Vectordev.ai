import { createDeviceOAuth, oauthToken } from "./device"
import { authorizeLoopback } from "./loopback"
import { xaiOAuthConfiguration } from "../provider-policy"

export function createXaiOAuth(dependencies?: Parameters<typeof createDeviceOAuth>[0] & { timeoutMs?: number }) {
  const device = createDeviceOAuth(dependencies)
  return {
    device: device.authorize,
    refresh: device.refresh,
    async browser(registration: NonNullable<ReturnType<typeof xaiOAuthConfiguration>>, signal: AbortSignal) {
      const flow = await authorizeLoopback(
        {
          clientId: registration.clientId,
          authorizeUrl: `${registration.origin}/oauth2/authorize`,
          tokenUrl: `${registration.origin}/oauth2/token`,
          redirectUri: registration.redirectUri,
          scope: registration.scope,
          authorization: { referrer: "vector" },
        },
        signal,
        dependencies,
      )
      const completed = flow
        .complete()
        .then((value) => oauthToken(registration, value, dependencies?.now?.() ?? Date.now()))
      void completed.catch(() => undefined)
      return { ...flow, complete: () => completed }
    },
  }
}
