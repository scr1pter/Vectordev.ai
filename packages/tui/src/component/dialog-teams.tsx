import { createSignal, onMount } from "solid-js"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"

type TeamOption = { accountID: string; orgID: string; orgName: string; active: boolean }

export function DialogTeams() {
  const sdk = useSDK()
  const { theme } = useTheme()
  const [teams, setTeams] = createSignal<TeamOption[]>([])
  const [active, setActive] = createSignal<string | undefined>()
  const [pending, setPending] = createSignal(false)
  const [message, setMessage] = createSignal("Loading verified Vector Teams memberships…")

  onMount(async () => {
    const result = await sdk.client.experimental.console.listOrgs().catch(() => undefined)
    if (!result?.data) {
      setMessage("Vector Teams could not refresh. Personal workspace remains available to clear team configuration.")
      return
    }
    setTeams(result.data.orgs)
    setActive(result.data.orgs.find((org) => org.active)?.orgID ?? "")
    setMessage(
      result.data.enabled
        ? "Choose a team to apply its provider, permission and integration defaults."
        : 'Vector Teams is unavailable or you are not signed in. Run "vector login" and try again.',
    )
  })

  return (
    <DialogSelect
      title="Vector Teams"
      current={active()}
      locked={pending()}
      options={[
        {
          value: "",
          title: "Personal workspace",
          description: active() === "" ? "active" : "local settings",
          disabled: pending(),
        },
        ...teams().map((team) => ({
          value: team.orgID,
          title: team.orgName,
          description: active() === team.orgID ? "active" : "team defaults",
          disabled: pending(),
        })),
      ]}
      footer={
        <box paddingLeft={4} paddingRight={4} paddingBottom={1}>
          <text fg={theme.textMuted}>{message()}</text>
        </box>
      }
      onSelect={async (option) => {
        if (pending()) return
        const team = teams().find((entry) => entry.orgID === option.value)
        if (option.value && !team) return
        setPending(true)
        setMessage("Saving team selection…")
        const result = await sdk.client.experimental.console
          .switchOrg({
            orgID: team?.orgID ?? null,
            ...(team ? { accountID: team.accountID } : {}),
          })
          .catch(() => undefined)
        setPending(false)
        if (result?.data !== true) {
          setMessage(
            "Vector could not confirm the selection. Reopen Vector Teams to refresh its saved state; you can retry Personal workspace.",
          )
          return
        }
        setActive(team?.orgID ?? "")
        setMessage(
          team
            ? `Active team: ${team.orgName}. Provider, permission and integration defaults are reloading.`
            : "Personal workspace selected. Your local configuration is reloading.",
        )
      }}
    />
  )
}
