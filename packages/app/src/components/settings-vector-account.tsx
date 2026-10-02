import { Button } from "@vectordevai/ui/button"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import type { VectorAccountStatus } from "../vector-account"

export function SettingsVectorAccount() {
  const platform = usePlatform()
  const [status, setStatus] = createSignal<VectorAccountStatus>({ authenticated: false, pending: false })
  const [busy, setBusy] = createSignal(false)
  onMount(() => {
    const account = platform.vectorAccount
    if (!account) return
    const unsubscribe = account.onChange(setStatus)
    onCleanup(unsubscribe)
    void account
      .status()
      .then(setStatus)
      .catch(() =>
        setStatus({ authenticated: false, pending: false, error: "Vector could not load account status. Try again." }),
      )
  })
  const act = async (action: "start" | "cancel" | "logout") => {
    const account = platform.vectorAccount
    if (!account || busy()) return
    setBusy(true)
    await account[action]()
      .then(setStatus)
      .catch(() =>
        setStatus((value) => ({ ...value, error: "Vector could not complete this account action. Try again." })),
      )
      .finally(() => setBusy(false))
  }
  return (
    <Show when={platform.vectorAccount}>
      <section class="flex flex-col gap-3" aria-labelledby="vector-account-title">
        <div>
          <h3 id="vector-account-title" class="text-14-medium text-text-strong">
            Vector account
          </h3>
          <p class="text-12-regular text-text-weak mt-1">
            Sign in to connect this desktop to your Vector account. Your provider keys are managed separately.
          </p>
        </div>
        <Show when={status().email}>
          <p class="text-12-regular">Signed in as {status().email}</p>
        </Show>
        <Show when={status().error}>
          <p role="alert" class="text-12-regular text-text-danger-base">
            {status().error}
          </p>
        </Show>
        <Show when={status().pending}>
          <p class="text-12-regular" role="status">
            Finish signing in in your browser, then return to Vector.
          </p>
        </Show>
        <div class="flex gap-2">
          <Show when={!status().pending}>
            <Button disabled={busy()} onClick={() => void act(status().authenticated ? "logout" : "start")}>
              {status().authenticated ? "Sign out of Vector" : "Sign in to Vector"}
            </Button>
          </Show>
          <Show when={status().pending}>
            <Button disabled={busy()} variant="secondary" onClick={() => void act("cancel")}>
              Cancel sign-in
            </Button>
          </Show>
        </div>
      </section>
    </Show>
  )
}
