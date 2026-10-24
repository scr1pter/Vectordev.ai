import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import type { LocalMode } from "@vectordevai/schema/local-mode"

// Where the desktop app looks for updates (plan section 4.9). A company's policy may name a mirror
// (`local.updates.url`): a generic electron-updater feed serving the same latest*.yml files and installers as Vector's
// own. Only where updates come from changes. electron-updater still checks each download against the sha512 the feed's
// file gives, Windows still checks the installer's publisher against the app-update.yml the app shipped with, and the
// macOS installer still checks the new app's signature and team. On Linux the feed's sha512 is the only check, so a
// mirror must use https, unless it is on this computer. The policy is read when the app starts, so a new mirror applies
// at the next start, and Vector Local lets automatic checks through to the mirror alone (LocalPolicy's "mirror" rule).

// Vector's own feed may name installers on Vector's download host rather than beside the feed, so a check Vector Local
// lets run may reach that host too. A company mirror serves its own installers and gets no such host.
export const VECTOR_DOWNLOADS = "https://downloads.vectordev.ai"

export type Feed = {
  readonly url: string
  /** Whether it is the company's mirror rather than the feed the app was built with. */
  readonly mirror: boolean
  /** What electron-updater's setFeedURL takes for the mirror; none for the built-in feed, which app-update.yml names. */
  readonly options?: { readonly provider: "generic"; readonly url: string; readonly channel: "latest" }
}

/**
 * The feed: the company's mirror when its policy names one Vector may use, else the one electron-builder wrote into
 * app-update.yml beside the app's resources (none in a development build). `ignored` says why a mirror was not used.
 */
export function updateFeed(input: { readonly policy: LocalMode.Policy; readonly resources: string | undefined }): {
  readonly feed?: Feed
  readonly ignored?: string
} {
  const named = input.policy.updates?.url
  const mirror = named === undefined ? undefined : companyMirror(named)
  if (mirror)
    return { feed: { url: mirror, mirror: true, options: { provider: "generic", url: mirror, channel: "latest" } } }
  const built = builtFeed(input.resources)
  return {
    ...(built ? { feed: { url: built, mirror: false } } : {}),
    ...(named === undefined
      ? {}
      : {
          ignored: `Ignored the update mirror ${named} in your company's policy: it must be an https address with no user name, password or query.`,
        }),
  }
}

// An https address with no user name, password, query or fragment, or an http one on this computer.
function companyMirror(value: string) {
  const text = value.trim()
  if (!URL.canParse(text)) return undefined
  const url = new URL(text)
  if (url.username || url.password || url.search || url.hash) return undefined
  if (url.protocol === "https:") return url.href
  if (url.protocol === "http:" && LocalPolicy.loopback(url.hostname)) return url.href
  return undefined
}

function builtFeed(resources: string | undefined) {
  if (!resources) return undefined
  const file = join(resources, "app-update.yml")
  if (!existsSync(file)) return undefined
  return readFileSync(file, "utf8").match(/^url:\s*['"]?([^'"\s]+)/m)?.[1]
}
