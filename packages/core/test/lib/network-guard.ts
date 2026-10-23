export * as NetworkGuard from "./network-guard"

import { afterAll, beforeAll } from "bun:test"
import { EgressGuard } from "../../src/local-mode/guard"
import { FakeWeb } from "./fake-web"

// The egress guard in strict mode for tests: a connection that would leave this computer throws EgressBlocked before
// it is made, or is refused by the guard's own proxy, and every attempt is listed. While it is installed the proxy
// environment points at that proxy, so a proxy the machine has set is not used. guard.ts lists what strict mode covers
// and what it does not. The fake web's names count as this computer, since its resolver pins them to 127.0.0.1. Engine
// tests import this by relative path, as they do core's other test fixtures.
//
// A package's preload can put a whole test run under the guard (`suite`, which the engine's does). A file's own
// `strict()` or `use()` then takes the suite's place while it runs, with that file's pinned names, and puts the suite's
// guard back when it is done, so no test runs without one.

// The guard a whole test run is under, and the names it was installed with.
const suiteState: { names?: readonly string[]; handle?: EgressGuard.Handle } = {}

/** Installs the strict guard for a whole test run. A package's preload calls it once, before any test file loads. */
export function suite(options: Pick<EgressGuard.StrictOptions, "names"> = {}) {
  if (suiteState.handle) return suiteState.handle
  // The proxy variables are set, empty, first. Removing a guard restores them, deleting one that was unset, and Bun's
  // fetch never sees a variable that was deleted set again: a file's guard put in the suite's place would then have its
  // proxy ignored, and a name it pins to this computer would be looked up and connected to where it really is.
  for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])
    process.env[name] ??= ""
  suiteState.names = options.names ?? []
  suiteState.handle = install(suiteState.names)
  return suiteState.handle
}

/**
 * Installs the strict guard now. Call `uninstall()` when the test is done; `use()` does both for a file. `proxy: false`
 * leaves out the guard's own proxy and the proxy environment that points at it, for a test of something Bun turns off
 * while a proxy is set (fetch.preconnect): the fetch, socket and WebSocket wraps still refuse any connection off this
 * computer, but Bun.fetch and a fetch captured before install are not seen.
 */
export function strict(options: Pick<EgressGuard.StrictOptions, "names" | "proxy"> = {}): EgressGuard.Handle {
  const outer = suiteState.handle
  if (!outer) return install(options.names ?? [], options.proxy)
  // The suite's guard steps aside for this one, and comes back when this one is removed.
  outer.uninstall()
  suiteState.handle = undefined
  const handle = install(options.names ?? [], options.proxy)
  const state = { removed: false }
  return {
    attempts: handle.attempts,
    uninstall: () => {
      if (state.removed) return
      state.removed = true
      handle.uninstall()
      suiteState.handle = install(suiteState.names ?? [])
    },
  }
}

/** Installs the strict guard for the calling test file's tests, and removes it after them. */
export function use(options: Pick<EgressGuard.StrictOptions, "names" | "proxy"> = {}) {
  const state: { handle?: EgressGuard.Handle } = {}
  beforeAll(() => {
    state.handle = strict(options)
  })
  afterAll(() => {
    state.handle?.uninstall()
    state.handle = undefined
  })
  return {
    attempts: () => state.handle?.attempts() ?? [],
    /** Attempts that would have left this computer. A test that passes expects none. */
    outside: () => (state.handle?.attempts() ?? []).filter((attempt) => !attempt.allowed),
  }
}

function install(names: readonly string[], proxy?: boolean) {
  return EgressGuard.installStrict({ names: [FakeWeb.DOMAIN, ...names], ...(proxy === false ? { proxy } : {}) })
}
