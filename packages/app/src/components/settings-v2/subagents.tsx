import "@/features/background-tasks/background-tasks.css"
import { For, Show, onCleanup } from "solid-js"
import { Button } from "@vectordevai/ui/button"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { Dialog } from "@vectordevai/ui/dialog"
import { Switch } from "@vectordevai/ui/v2/switch-v2"
import { GENERAL_SUBAGENT_ID } from "@vectordevai/session-ui/subagent-identity"
import { SUBAGENT_IDENTITIES, SubagentAvatar } from "@/features/agents/identities"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"
import { helperLabel, isInternalSession } from "@/utils/internal-sessions"
import {
  SPECIALIST_IDS,
  agentEnabled,
  createAgentSwitchSaver,
  runningWork,
  stopWorkDescription,
} from "./subagent-switches"

// Vector hands work to two kinds of subagent, and this page explains both.
// Subagents are the engine's general-purpose `general` agent, which the main
// agent starts on its own for big tasks, one per independent part, in
// parallel; small tasks it does itself. Subagent specialists are every other
// agent, each with one focus; user-defined agents count as specialists too.
// The page has a switch for General subagents, one for each specialist that
// ships with Vector and one for all of those specialists at once. Each writes
// `agent.<id>.disable` to the connected engine's global config, saved
// together when flipped in quick succession (subagent-switches.ts). The page
// reads that config from server sync, so it waits for the saved value instead
// of showing the default, and it asks first when a change would stop running
// sessions. Agents the user defined have no switch: they live in the
// user's own config. No directory store is needed, so the page works where
// none exists.

const SUBAGENT_FACTS = [
  {
    title: "When Vector uses them",
    description:
      "When splitting the work costs less than doing it: a substantial independent part, roughly five or more files or a long check-and-repair loop, or broad research that would flood the main agent's context. Each Subagent starts fresh and re-reads what it needs, so ordinary multi-file changes the main agent does itself.",
  },
  {
    title: "Where they work",
    description: "In this session's checkout, with the main agent's tools. They report to the main agent, not to you.",
  },
  {
    title: "Where you see them",
    description:
      "A card in the chat where each one started, and a row in Background tasks while it runs and after it finishes.",
  },
  {
    title: "How many",
    description:
      "One for each independent part of a big task, with no cap. When more than six are running at once, Vector tells you how many.",
  },
  {
    title: "How deep",
    description: "One level by default; subagents cannot start subagents of their own.",
  },
] as const

const LEGEND = [
  { status: "running", label: "Running" },
  { status: "waiting", label: "Waiting on you" },
  { status: "done", label: "Done" },
  { status: "failed", label: "Failed" },
  { status: "pending", label: "Not started" },
] as const

// Saving a switch reloads the engine's state, which stops every running
// session, so the page asks first whenever something is working.
function DialogStopRunningWork(props: {
  work: ReturnType<typeof runningWork>
  title: string
  enable: boolean
  onConfirm: () => void
}) {
  const dialog = useDialog()
  return (
    <Dialog title={props.title} description={stopWorkDescription(props.work)} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="large"
            onClick={() => {
              dialog.close()
              props.onConfirm()
            }}
          >
            {props.enable ? "Turn on anyway" : "Turn off anyway"}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function SettingsSubagentsV2() {
  const serverSync = useServerSync()
  const language = useLanguage()
  const dialog = useDialog()
  const specialists = SPECIALIST_IDS.flatMap((id) => SUBAGENT_IDENTITIES[id] ?? [])

  // The saved values are the engine's global config, as server sync holds
  // it: a save writes its result there before it resolves. Unlike
  // serverSync().data.config, which is {} until the config arrives and so
  // reads as "on", it says whether the saved value is actually known.
  const loaded = () => serverSync().globalConfig() !== undefined
  const saver = createAgentSwitchSaver({
    saved: (id) => agentEnabled(serverSync().globalConfig() ?? {}, id),
    save: (patch) => serverSync().updateConfig(patch),
    onError: (error, ids) =>
      showToast({
        variant: "error",
        title: "Could not save your change",
        description: `${switchNames(ids)} ${ids.length === 1 ? "is" : "are"} back to the saved setting. ${formatServerError(error, language.t)}`,
      }),
  })
  // Closing Settings right after a flip still saves it.
  onCleanup(() => void saver.flush())

  const anySpecialist = () => SPECIALIST_IDS.some((id) => saver.enabled(id))
  const flip = (ids: readonly string[], enable: boolean, title: string) => {
    if (ids.every((id) => saver.enabled(id) === enable)) return
    const apply = () => saver.pick(Object.fromEntries(ids.map((id) => [id, enable])))
    // Flipping back before the save goes out saves nothing, so nothing stops.
    if (ids.every((id) => saver.committed(id) === enable)) return apply()
    const work = runningWork(serverSync().session.data.session_status, (sessionID) => {
      const session = serverSync().session.get(sessionID)
      return isInternalSession(session) ? helperLabel(session?.internal ?? "") : undefined
    })
    if (work.sessions === 0 && work.helpers.length === 0) return apply()
    void dialog.show(() => <DialogStopRunningWork work={work} title={title} enable={enable} onConfirm={apply} />)
  }
  const unknown = () => (
    <span class="settings-v2-row-description">
      {serverSync().globalConfigFailed()
        ? "Could not read this setting. Reopen Settings to try again."
        : language.t("common.loading")}
    </span>
  )

  return (
    <section class="settings-v2-page">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Subagents</p>
          <h2 class="settings-v2-page-title">Subagents and subagent specialists</h2>
          <p class="settings-v2-page-subtitle">
            Vector's agent can hand the parts of a big task to other agents and keep working. There are two kinds, and
            you will see both in the chat and in Background tasks.
          </p>
        </div>
      </div>

      <div class="settings-v2-card settings-v2-card--wide">
        <div class="settings-v2-card-head" style={{ "grid-template-columns": "1fr" }}>
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">Subagents</h3>
            <p class="settings-v2-card-description">
              General-purpose agents that Vector's agent starts on its own for big tasks, one for each independent part,
              all running at the same time. Small tasks it does itself.
            </p>
          </div>
        </div>
        <div class="settings-v2-card-body">
          <div class="settings-v2-row-modern">
            <div class="settings-v2-row-copy">
              <div class="settings-v2-row-title">General subagents</div>
              <div class="settings-v2-row-description">
                Vector's agent hands big, multi-part tasks to general-purpose subagents that run in parallel. Turn this
                off to keep that work in the main agent; subagent specialists still work. Changing it stops any work in
                progress, so Vector asks first when something is running, and the new setting applies from your next
                message.
              </div>
            </div>
            <div class="settings-v2-row-control settings-v2-row-control--compact">
              <Show when={loaded()} fallback={unknown()}>
                <Switch
                  checked={saver.enabled(GENERAL_SUBAGENT_ID)}
                  onChange={(next) =>
                    flip([GENERAL_SUBAGENT_ID], next, `Turn general subagents ${next ? "on" : "off"}?`)
                  }
                  hideLabel
                >
                  General subagents
                </Switch>
              </Show>
            </div>
          </div>
          <div class="settings-v2-row-modern">
            <div class="settings-v2-row-copy">
              <div class="settings-v2-row-title">Subagent specialists</div>
              <div class="settings-v2-row-description">
                Named agents with one focus each, such as Review and Security. Turn this off to keep all of their work
                in the main agent, or turn them off one at a time under Subagent specialists below. Build, Plan, general
                subagents and agents you define yourself are not changed, and Vector's own helpers, such as a
                Vectorscope review, keep working. As with General subagents, Vector asks first when something is
                running.
              </div>
            </div>
            <div class="settings-v2-row-control settings-v2-row-control--compact">
              <Show when={loaded()} fallback={unknown()}>
                <Switch
                  checked={anySpecialist()}
                  onChange={(next) =>
                    flip(SPECIALIST_IDS, next, `Turn all subagent specialists ${next ? "on" : "off"}?`)
                  }
                  hideLabel
                >
                  Subagent specialists
                </Switch>
              </Show>
            </div>
          </div>
          <div class="settings-v2-row-modern settings-v2-row-modern--stacked">
            <div class="settings-v2-row-copy">
              <div class="settings-v2-row-title">In the terminal</div>
              <div class="settings-v2-row-description">
                The terminal reads its own config file. To turn subagents off there, set agent.general.disable to true
                in ~/.config/vector/vector.json {"(%USERPROFILE%\\.config\\vector\\vector.json on Windows)"}, or the
                specialist's own name for a subagent specialist, for example agent.review.disable. It takes effect the
                next time you start Vector in the terminal. The same settings in a repository's vector.json turn them
                off for that repository everywhere, whatever these switches say.
              </div>
            </div>
          </div>
          <For each={SUBAGENT_FACTS}>
            {(fact) => (
              <div class="settings-v2-row-modern settings-v2-row-modern--stacked">
                <div class="settings-v2-row-copy">
                  <div class="settings-v2-row-title">{fact.title}</div>
                  <div class="settings-v2-row-description">{fact.description}</div>
                </div>
              </div>
            )}
          </For>
          <div class="settings-v2-row-modern settings-v2-row-modern--stacked">
            <div class="settings-v2-row-copy">
              <div class="settings-v2-row-title">How Background tasks marks them</div>
              <div class="settings-v2-row-description">
                Each agent is one mark: a square for a subagent, a dot for a subagent specialist. Its colour says where
                it is.
              </div>
              <ul class="vector-bg-tasks-legend" aria-label="Status colours">
                <For each={LEGEND}>
                  {(item) => (
                    <li class="vector-bg-tasks-legend-item">
                      <span class="vector-bg-tasks-square" data-status={item.status} aria-hidden="true" />
                      <span
                        class="vector-bg-tasks-square"
                        data-status={item.status}
                        data-kind="specialist"
                        aria-hidden="true"
                      />
                      {item.label}
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-v2-card settings-v2-card--wide">
        <div class="settings-v2-card-head" style={{ "grid-template-columns": "1fr" }}>
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">Subagent specialists</h3>
            <p class="settings-v2-card-description">
              Named agents with one focus each and the permissions to match. Vector calls one when part of a task fits
              its focus. To ask for one yourself, type @ and its name in the composer.
            </p>
          </div>
        </div>
        <div class="settings-v2-card-body">
          <For each={specialists}>
            {(identity) => (
              <div
                class="settings-v2-row-modern settings-v2-specialist"
                data-off={loaded() && !saver.enabled(identity.id) ? "" : undefined}
              >
                <SubagentAvatar id={identity.id} size={30} />
                <div class="settings-v2-row-copy">
                  <div class="settings-v2-pet-name">
                    {identity.name}
                    <span class="settings-v2-pet-species">{identity.summary}</span>
                    <Show when={identity.readOnly}>
                      <span class="settings-v2-pet-badge">read-only</span>
                    </Show>
                    <span class="settings-v2-pet-id">{identity.id}</span>
                  </div>
                  <div class="settings-v2-row-description">{identity.detail}</div>
                </div>
                <div class="settings-v2-row-control settings-v2-row-control--compact">
                  <Show when={loaded()}>
                    <Switch
                      checked={saver.enabled(identity.id)}
                      onChange={(next) =>
                        flip([identity.id], next, `Turn the ${identity.name} specialist ${next ? "on" : "off"}?`)
                      }
                      hideLabel
                    >
                      {`${identity.name} specialist`}
                    </Switch>
                  </Show>
                </div>
              </div>
            )}
          </For>
          <p class="settings-v2-row-description">
            Explore, Review, Security and Judge can read your repository and run checks, but cannot edit it. In Plan
            mode, Vector uses only Explore, Review and Security, and with Judge off it skips the LLM-as-a-judge check. A
            specialist you turn off leaves the @ list and Vector stops calling it, but Vectorscope still reviews with
            Review and Security. Specialists keep working when General subagents is off. Agents you define yourself
            count as subagent specialists too, and these switches leave them alone.
          </p>
        </div>
      </div>
    </section>
  )
}

// The switches' names for a failed save's message: "General subagents", or a
// specialist's own name, joined as "Review, Test and Debug".
function switchNames(ids: readonly string[]) {
  const names = ids.map((id) =>
    id === GENERAL_SUBAGENT_ID ? "General subagents" : (SUBAGENT_IDENTITIES[id]?.name ?? id),
  )
  if (names.length <= 1) return names.join("")
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}
