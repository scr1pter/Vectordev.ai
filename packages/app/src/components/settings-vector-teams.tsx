import { useQueryClient } from "@tanstack/solid-query"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { TeamsPicker } from "./settings-teams"

export function SettingsVectorTeams() {
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const queryClient = useQueryClient()
  const [accountRevision, setAccountRevision] = createSignal(0)
  onMount(() => {
    const account = platform.vectorAccount
    if (account) onCleanup(account.onChange(() => setAccountRevision((value) => value + 1)))
  })
  // A server/account change remounts the picker; old requests cannot update its new state.
  const scope = createMemo(() => ({ sdk: serverSDK(), accountRevision: accountRevision() }))
  return (
    <Show when={scope()} keyed>
      {(current) => (
        <TeamsPicker
          load={async () => {
            const result = await current.sdk.client.experimental.console.listOrgs()
            if (!result.data) throw new Error("Vector could not verify team membership.")
            return result.data
          }}
          select={async (team) => {
            const result = await current.sdk.client.experimental.console.switchOrg({
              orgID: team?.orgID ?? null,
              ...(team ? { accountID: team.accountID } : {}),
            })
            if (result.data !== true) throw new Error("Vector could not confirm the selected team.")
            // Selection is already committed. A failed UI refresh must not claim it failed.
            void queryClient
              .invalidateQueries({
                predicate: (query) => query.queryKey[0] === current.sdk.scope,
              })
              .catch(() => undefined)
          }}
        />
      )}
    </Show>
  )
}
