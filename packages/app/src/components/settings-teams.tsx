import { Button } from "@vectordevai/ui/button"
import type { ExperimentalConsoleListOrgsResponse } from "@vectordevai/sdk/v2/client"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

type TeamOption = ExperimentalConsoleListOrgsResponse["orgs"][number]

/** Shared by desktop settings and browser acceptance fixtures. The server owns membership and signature checks. */
export function TeamsPicker(props: {
  load: () => Promise<ExperimentalConsoleListOrgsResponse>
  select: (team: TeamOption | null) => Promise<void>
}) {
  const [teams, setTeams] = createSignal<TeamOption[]>([])
  const [active, setActive] = createSignal("")
  const [selected, setSelected] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [enabled, setEnabled] = createSignal(false)
  const [error, setError] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const lifecycle = { current: true }
  onCleanup(() => {
    lifecycle.current = false
  })

  const refresh = async () => {
    if (busy()) return
    setBusy(true)
    setError("")
    await props
      .load()
      .then((result) => {
        if (!lifecycle.current) return
        setEnabled(result.enabled)
        setTeams(result.orgs)
        const chosen = result.orgs.find((team) => team.active)?.orgID ?? ""
        setActive(chosen)
        setSelected(chosen)
        setLoaded(true)
      })
      .catch(() => {
        if (lifecycle.current)
          setError("Vector could not refresh your teams. Your current team selection is unchanged.")
      })
      .finally(() => {
        if (lifecycle.current) setBusy(false)
      })
  }
  onMount(() => void refresh())

  const apply = async () => {
    if (busy() || (loaded() && selected() === active())) return
    const target = teams().find((team) => team.orgID === selected())
    if (selected() && !target) return
    setBusy(true)
    setError("")
    setNotice("")
    await props
      .select(target ?? null)
      .then(() => {
        if (!lifecycle.current) return
        setActive(target?.orgID ?? "")
        setLoaded(true)
        setTeams((list) => list.map((team) => ({ ...team, active: team.orgID === target?.orgID })))
        setNotice(
          target
            ? `Using ${target.orgName}. Team settings apply when the workspace reloads.`
            : "Using Personal workspace.",
        )
      })
      .catch(() => {
        if (lifecycle.current) {
          setSelected(active())
          setError("Vector could not confirm the switch. Refresh teams to check which team is active.")
        }
      })
      .finally(() => {
        if (lifecycle.current) setBusy(false)
      })
  }

  return (
    <section class="settings-form-section flex flex-col gap-3" aria-labelledby="vector-teams-title" aria-busy={busy()}>
      <div>
        <h3 id="vector-teams-title" class="text-14-medium text-text-strong">
          Vector Teams
        </h3>
        <p class="text-12-regular text-text-weak mt-1">
          Choose the team settings for this server. Team settings can include providers, permissions, and integrations;
          personal and project settings still take precedence.
        </p>
      </div>
      <label class="text-12-regular" for="vector-team-selection">
        Workspace team
      </label>
      <div class="flex flex-wrap items-center gap-2">
        <select
          id="vector-team-selection"
          value={selected()}
          disabled={busy()}
          onChange={(event) => setSelected(event.currentTarget.value)}
          class="min-w-[220px] flex-1 rounded-md border border-border-weak-base bg-surface-base px-3 py-2 text-14-regular text-text-strong"
        >
          <option value="">Personal workspace</option>
          <For each={teams()}>{(team) => <option value={team.orgID}>{team.orgName}</option>}</For>
        </select>
        <Button disabled={busy() || (loaded() && selected() === active())} onClick={() => void apply()}>
          Apply team settings
        </Button>
        <Button disabled={busy()} variant="secondary" onClick={() => void refresh()}>
          Refresh teams
        </Button>
      </div>
      <Show when={loaded() && teams().length === 0}>
        <p class="text-12-regular text-text-weak">
          {enabled()
            ? "No teams have been shared with this Vector account."
            : "Sign in to Vector on this server to load your teams. Teams must also be enabled by your operator."}
        </p>
      </Show>
      <Show when={error()}>
        <p class="text-12-regular text-text-danger-base" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={notice()}>
        <p class="text-12-regular" role="status">
          {notice()}
        </p>
      </Show>
    </section>
  )
}
