import { createHash, randomBytes } from "node:crypto"
import type { VectorAccountStatus } from "@vectordevai/app/vector-account"

type StoredAccount = { ciphertext: string; email: string; expiresAt: number }
type Pending = { state: string; verifier: string; expiresAt: number; exchanging?: boolean }
type Dependencies = {
  read(): unknown
  write(value: StoredAccount): void
  clear(): Promise<void>
  available(): Promise<boolean>
  encrypt(token: string): Promise<string>
  decrypt(ciphertext: string): Promise<string>
  openBrowser(url: string): Promise<void>
  fetch(url: string, options: RequestInit): Promise<Response>
  sync(token: string | undefined): Promise<void>
  changed(status: VectorAccountStatus): void
  now?(): number
}

const secureStorageError =
  "Vector cannot store your account securely. Unlock the operating system credential store and try again."

export function createVectorAccount(deps: Dependencies) {
  const now = deps.now ?? Date.now
  const state: { pending?: Pending; error?: string; work: Promise<void> } = { work: Promise.resolve() }
  const stored = () => {
    const value = deps.read()
    if (
      !value ||
      typeof value !== "object" ||
      !("ciphertext" in value) ||
      !("email" in value) ||
      !("expiresAt" in value) ||
      typeof value.ciphertext !== "string" ||
      typeof value.email !== "string" ||
      typeof value.expiresAt !== "number"
    )
      return
    return { ciphertext: value.ciphertext, email: value.email, expiresAt: value.expiresAt }
  }
  const status = (): VectorAccountStatus => {
    const account = stored()
    const authenticated = Boolean(account && account.expiresAt > now())
    return {
      authenticated,
      pending: Boolean(state.pending && state.pending.expiresAt > now()),
      ...(authenticated && account ? { email: account.email, expiresAt: account.expiresAt } : {}),
      ...(state.error ? { error: state.error } : {}),
    }
  }
  const notify = () => {
    const value = status()
    deps.changed(value)
    return value
  }
  const queue = (operation: () => Promise<void>) => {
    const work = state.work.then(operation, operation)
    state.work = work.catch(() => {})
    return work
  }
  const fail = (message: string) => {
    state.error = message
    return notify()
  }

  return {
    status,
    async start() {
      if (!(await deps.available())) return fail(secureStorageError)
      state.error = undefined
      const pending = {
        state: randomBytes(32).toString("base64url"),
        verifier: randomBytes(32).toString("base64url"),
        expiresAt: now() + 300_000,
      }
      state.pending = pending
      const url = new URL("https://vectordev.ai/auth/cli")
      url.search = new URLSearchParams({
        desktop: "1",
        state: pending.state,
        code_challenge: createHash("sha256").update(pending.verifier).digest("base64url"),
        code_challenge_method: "S256",
      }).toString()
      await deps.openBrowser(url.href).catch(() => {
        state.pending = undefined
        state.error = "Vector could not open your browser. Try signing in again."
      })
      return notify()
    },
    cancel() {
      state.pending = undefined
      state.error = undefined
      return notify()
    },
    async logout() {
      state.pending = undefined
      state.error = undefined
      await queue(async () => {
        await deps.sync(undefined)
        await deps.clear()
      }).catch(() => {
        state.error = "Vector could not finish signing out. Start the local server and try again."
      })
      return notify()
    },
    async restore() {
      await queue(async () => {
        const account = stored()
        if (!account) return
        if (account.expiresAt <= now()) {
          await deps.sync(undefined)
          await deps.clear()
          state.error = "Your Vector sign-in expired. Sign in again."
          return
        }
        if (!(await deps.available())) throw new Error(secureStorageError)
        await deps.sync(await deps.decrypt(account.ciphertext))
      }).catch(() => {
        state.error = "Vector could not restore your account securely. Unlock the credential store or sign in again."
      })
      return notify()
    },
    async consume(urls: string[]) {
      const remaining: string[] = []
      for (const raw of urls) {
        const url = URL.canParse(raw) ? new URL(raw) : undefined
        // Even malformed account callbacks must stay out of generic renderer events/logs.
        if (
          !(url?.protocol === "vector:" && url.hostname === "auth") &&
          !/^vector:\/\/auth(?:[/?#\\]|$)/i.test(raw.trim())
        ) {
          remaining.push(raw)
          continue
        }
        const pending = state.pending
        if (
          !url ||
          url.protocol !== "vector:" ||
          url.hostname !== "auth" ||
          url.pathname !== "/callback" ||
          url.hash ||
          url.username ||
          url.password ||
          url.port ||
          url.searchParams.size !== 2 ||
          url.searchParams.getAll("code").length !== 1 ||
          url.searchParams.getAll("state").length !== 1 ||
          !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code") ?? "") ||
          !pending ||
          pending.expiresAt <= now() ||
          url.searchParams.get("state") !== pending.state
        ) {
          fail("This sign-in link is no longer valid. Start sign-in again in Vector.")
          continue
        }
        if (pending.exchanging) continue
        pending.exchanging = true
        const response = await deps
          .fetch("https://vectordev.ai/api/account/cli-exchange", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              code: url.searchParams.get("code"),
              state: pending.state,
              verifier: pending.verifier,
            }),
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          })
          .catch(() => undefined)
        const payload: unknown = await response?.json().catch(() => undefined)
        if (state.pending !== pending) continue
        if (
          !response?.ok ||
          !payload ||
          typeof payload !== "object" ||
          !("token" in payload) ||
          typeof payload.token !== "string" ||
          !payload.token.startsWith("vct_") ||
          !("expiresAt" in payload) ||
          typeof payload.expiresAt !== "number" ||
          payload.expiresAt <= now() ||
          !("user" in payload) ||
          !payload.user ||
          typeof payload.user !== "object" ||
          !("email" in payload.user) ||
          typeof payload.user.email !== "string"
        ) {
          state.pending = undefined
          fail("Vector could not complete sign-in. The link may have expired; start sign-in again.")
          continue
        }
        const account = { token: payload.token, email: payload.user.email, expiresAt: payload.expiresAt }
        await queue(async () => {
          if (state.pending !== pending) return
          if (!(await deps.available())) throw new Error(secureStorageError)
          const ciphertext = await deps.encrypt(account.token)
          if (state.pending !== pending) return
          deps.write({ ciphertext, email: account.email, expiresAt: account.expiresAt })
          // Persistence is the commit point. A newer browser flow must not be
          // cancelled when this earlier engine synchronization completes.
          state.pending = undefined
          state.error = undefined
          notify()
          await deps.sync(account.token)
        }).catch(() => {
          if (state.pending === pending) state.pending = undefined
          if (!state.pending)
            state.error =
              "Vector could not finish secure setup. Unlock the credential store and restart Vector, or sign in again."
        })
        notify()
      }
      return remaining
    },
  }
}

/** The account token may only be copied to the app's authenticated local sidecar. */
export async function syncVectorAccount(
  connection: { url: string; username: string | null; password: string | null },
  token: string | undefined,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const url = new URL(connection.url)
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    !connection.username ||
    !connection.password
  )
    throw new Error("Vector account setup requires the authenticated local server.")
  const response = await fetcher(new URL("/auth/vector", url).href, {
    method: token ? "PUT" : "DELETE",
    headers: {
      authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
      "content-type": "application/json",
    },
    ...(token ? { body: JSON.stringify({ type: "api", key: token }) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error("Vector could not update the local account credential.")
  const refreshed = await fetcher(new URL("/global/dispose", url).href, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  if (!refreshed.ok) throw new Error("Vector could not refresh the local account connection.")
}
