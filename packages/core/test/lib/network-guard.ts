export * as NetworkGuard from "./network-guard"

import { afterAll, beforeAll } from "bun:test"
import { EgressGuard } from "../../src/local-mode/guard"
import { FakeWeb } from "./fake-web"

// The egress guard in strict mode for tests: a connection that would leave this computer throws EgressBlocked before
// it is made, or is refused by the guard's own proxy, and every attempt is listed. While it is installed the proxy
// environment points at that proxy, so a proxy the machine has set is not used. guard.ts lists what strict mode covers
// and what it does not. The fake web's names count as this computer, since its resolver pins them to 127.0.0.1. Engine
// tests import this by relative path, as they do core's other test fixtures.

/** Installs the strict guard now. Call `uninstall()` when the test is done; `use()` does both for a file. */
export function strict(options: EgressGuard.Options = {}) {
  return EgressGuard.installStrict({ names: [FakeWeb.DOMAIN, ...(options.names ?? [])] })
}

/** Installs the strict guard for the calling test file's tests, and removes it after them. */
export function use(options: EgressGuard.Options = {}) {
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
