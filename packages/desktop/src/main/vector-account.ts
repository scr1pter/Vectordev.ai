import { createHash, randomBytes } from "node:crypto"
import type { VectorAccountStatus } from "@vectordevai/app/vector-account"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"

type StoredAccount = {
  ciphertext: string
  email: string
  name?: string
  /** The profile photo as a data URL, so the renderer shows it without loading a third-party URL. */
  avatar?: string
  /** The https URL that photo came from, so an unchanged photo is not downloaded again. */
  avatarSource?: string
  /** When the name and photo last came from vectordev.ai. */
  profileAt?: number
  expiresAt: number
}
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
const PROFILE_INTERVAL_MS = 24 * 60 * 60 * 1_000
const PHOTO_BYTES = 256 * 1024
const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]
const photoData = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/

export function createVectorAccount(deps: Dependencies) {
  const now = deps.now ?? Date.now
  const state: { pending?: Pending; error?: string; refreshing?: boolean; work: Promise<void> } = {
    work: Promise.resolve(),
  }
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
    const avatar =
      "avatar" in value &&
      typeof value.avatar === "string" &&
      value.avatar.length <= PHOTO_BYTES * 2 &&
      photoData.test(value.avatar)
        ? value.avatar
        : undefined
    const avatarSource = "avatarSource" in value ? photoSource(value.avatarSource) : undefined
    return {
      ciphertext: value.ciphertext,
      email: value.email,
      // Sign-ins saved before names were stored have none; the app then shows the email.
      ...("name" in value && typeof value.name === "string" && value.name ? { name: value.name } : {}),
      // The photo and its source go together; anything else is dropped and the app shows the initial.
      ...(avatar && avatarSource ? { avatar, avatarSource } : {}),
      ...("profileAt" in value && typeof value.profileAt === "number" ? { profileAt: value.profileAt } : {}),
      expiresAt: value.expiresAt,
    }
  }
  const status = (): VectorAccountStatus => {
    const account = stored()
    const authenticated = Boolean(account && account.expiresAt > now())
    return {
      authenticated,
      pending: Boolean(state.pending && state.pending.expiresAt > now()),
      ...(authenticated && account
        ? {
            email: account.email,
            ...(account.name ? { name: account.name } : {}),
            ...(account.avatar ? { avatar: account.avatar } : {}),
            expiresAt: account.expiresAt,
          }
        : {}),
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
  const token = async () => {
    const account = stored()
    if (!account || account.expiresAt <= now() || !(await deps.available())) return
    return deps.decrypt(account.ciphertext)
  }
  // Display only, so every failure keeps the last good name and photo.
  const applyProfile = async (ciphertext: string, profile: { name: string; source?: string }) => {
    const current = stored()
    const kept = profile.source && current?.avatarSource === profile.source ? current.avatar : undefined
    const photo = kept ?? (profile.source ? await downloadPhoto(profile.source, deps.fetch) : undefined)
    // Settled once the account has no photo or this one is in hand; otherwise the next refresh tries again.
    const settled = !profile.source || Boolean(photo)
    await queue(async () => {
      const account = stored()
      // Signed out, or signed in again as someone else, while the photo downloaded.
      if (!account || account.ciphertext !== ciphertext) return
      deps.write({
        ciphertext: account.ciphertext,
        email: account.email,
        ...(profile.name ? { name: profile.name } : {}),
        ...(photo && profile.source ? { avatar: photo, avatarSource: profile.source } : {}),
        // A photo that could not be downloaded keeps the last good one.
        ...(!settled && account.avatar ? { avatar: account.avatar, avatarSource: account.avatarSource } : {}),
        ...(settled ? { profileAt: now() } : account.profileAt ? { profileAt: account.profileAt } : {}),
        expiresAt: account.expiresAt,
      })
    }).catch(() => undefined)
    notify()
  }

  return {
    status,
    /** Main process only: the signed-in token for requests to vectordev.ai, never sent to a renderer. */
    token,
    /**
     * Startup: refreshes the name and photo from vectordev.ai at most once a day, and only while signed in, so a
     * sign-in saved before either was carried gets them without signing in again.
     */
    async refreshProfile() {
      const account = stored()
      if (
        !account ||
        account.expiresAt <= now() ||
        state.refreshing ||
        (account.profileAt !== undefined && now() - account.profileAt < PROFILE_INTERVAL_MS)
      )
        return status()
      state.refreshing = true
      const secret = await token().catch(() => undefined)
      const response = secret
        ? await deps
            .fetch("https://vectordev.ai/api/account/profile", {
              headers: { accept: "application/json", authorization: `Bearer ${secret}` },
              redirect: "error",
              signal: AbortSignal.timeout(15_000),
            })
            .catch(() => undefined)
        : undefined
      const payload: unknown = await response?.json().catch(() => undefined)
      if (response?.ok && payload && typeof payload === "object")
        await applyProfile(account.ciphertext, {
          name: "name" in payload && typeof payload.name === "string" ? payload.name.trim().slice(0, 120) : "",
          source: "avatar" in payload ? photoSource(payload.avatar) : undefined,
        })
      state.refreshing = false
      return status()
    },
    /** The account's Vector Codium plan and balances. The token goes only to vectordev.ai; the renderer gets the result. */
    async codium() {
      return ModelPlanStatus.fetchStatus(await token().catch(() => undefined), deps.fetch)
    },
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
        const name =
          "name" in payload.user && typeof payload.user.name === "string" ? payload.user.name.trim().slice(0, 120) : ""
        const source = "avatar" in payload.user ? photoSource(payload.user.avatar) : undefined
        const account = { token: payload.token, email: payload.user.email, name, expiresAt: payload.expiresAt }
        const committed: { ciphertext?: string } = {}
        await queue(async () => {
          if (state.pending !== pending) return
          if (!(await deps.available())) throw new Error(secureStorageError)
          const ciphertext = await deps.encrypt(account.token)
          if (state.pending !== pending) return
          deps.write({
            ciphertext,
            email: account.email,
            ...(account.name ? { name: account.name } : {}),
            expiresAt: account.expiresAt,
          })
          committed.ciphertext = ciphertext
          // Persistence is the commit point. A newer browser flow must not be
          // cancelled when this earlier engine synchronization completes.
          state.pending = undefined
          state.error = undefined
          await deps.sync(account.token)
        }).catch(() => {
          if (state.pending === pending) state.pending = undefined
          if (!state.pending)
            state.error =
              "Vector could not finish secure setup. Unlock the credential store and restart Vector, or sign in again."
        })
        notify()
        // The exchange carries the current name and photo, so this sign-in needs no profile refresh.
        if (committed.ciphertext) await applyProfile(committed.ciphertext, { name: account.name, source })
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

/** Google's avatar hosts over https only, the same list vectordev.ai checks before it hands a photo out. */
function photoSource(value: unknown) {
  if (typeof value !== "string" || value.length > 2_048) return
  const url = URL.parse(value)
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^lh\d\.googleusercontent\.com$/.test(url.hostname)
  )
    return
  return url.href
}

/**
 * The photo is downloaded here, in the main process, and handed to the renderer as a data URL, so the renderer never
 * loads a third-party URL and its content security policy stays as it is. Any failure returns nothing.
 */
async function downloadPhoto(source: string, fetcher: Dependencies["fetch"]) {
  const response = await fetcher(source, {
    headers: { accept: PHOTO_TYPES.join(",") },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  const type = response?.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? ""
  const reader = response?.body?.getReader()
  if (
    !response?.ok ||
    !reader ||
    !PHOTO_TYPES.includes(type) ||
    Number(response.headers.get("content-length")) > PHOTO_BYTES
  ) {
    await reader?.cancel().catch(() => undefined)
    return
  }
  // The declared length can be missing or wrong, so the cap holds while reading.
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const next = await reader.read().catch(() => undefined)
    if (!next) return
    if (next.done) break
    received += next.value.byteLength
    if (received > PHOTO_BYTES) {
      await reader.cancel().catch(() => undefined)
      return
    }
    chunks.push(next.value)
  }
  if (!received) return
  return `data:${type};base64,${Buffer.concat(chunks).toString("base64")}`
}
