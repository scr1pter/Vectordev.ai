import { createMemo, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { useLanguage } from "@/context/language"

/** Read-only platform status until the onboarding and preference controls arrive in D6b. */
export function SettingsComputerStatus(props: { computer: Computer.ComputerPlatform }) {
  const language = useLanguage()
  const [store, setStore] = createStore<{
    status?: Awaited<ReturnType<Computer.ComputerPlatform["status"]>>
    phase?: Computer.ComputerPhase
    failed: boolean
  }>({ failed: false })
  onMount(() => {
    if (!props.computer.supported) return
    let active = true
    let observed = false
    const unsubscribe = props.computer.onState((state) => {
      if (!active) return
      observed = true
      setStore("phase", state.phase)
    })
    onCleanup(() => {
      active = false
      unsubscribe()
    })
    void props.computer.status().then(
      (status) => active && setStore("status", status),
      () => active && setStore("failed", true),
    )
    void props.computer.state().then(
      // A live event can arrive before this initial snapshot resolves; never replace it with an older phase.
      (state) => active && !observed && setStore("phase", state.phase),
      () => active && !observed && setStore("failed", true),
    )
  })
  const status = createMemo(() => {
    if (!props.computer.supported) return language.t("computer.status.linux")
    if (store.failed) return language.t("computer.availability.desktop", { name: Hands.NAME })
    if (!store.status) return undefined
    if (store.status.reason === "policy_disabled") return language.t("computer.status.companyOff")
    if (!store.phase) return undefined
    if (store.phase === "off") return language.t("computer.status.off")
    if (store.phase === "setup" || store.status.reason === "permissions")
      return language.t("computer.status.needsPermissions")
    if (!store.status.available) return language.t("computer.status.off")
    if (store.status.helper?.signing === "adhoc") return language.t("computer.status.preview")
    return language.t("computer.status.ready")
  })
  return (
    <section class="settings-v2-page" data-computer-status>
      <div class="settings-v2-page-hero">
        <h2 class="settings-v2-page-title">{language.t("computer.name", { name: Hands.NAME })}</h2>
      </div>
      <Show when={status()}>{(value) => <p role="status">{value()}</p>}</Show>
    </section>
  )
}
