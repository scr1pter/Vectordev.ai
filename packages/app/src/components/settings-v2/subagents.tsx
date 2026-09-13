import "@/features/background-tasks/background-tasks.css"
import { For, Show, createEffect, createSignal } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { GENERAL_SUBAGENT_ID } from "@opencode-ai/session-ui/subagent-identity"
import { SUBAGENT_IDENTITIES, SubagentAvatar } from "@/features/agents/identities"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import {
  generalSubagentsEnabled,
  generalSubagentsPatch,
  runningSessions,
  stopWorkDescription,
} from "./general-subagents"

// Vector hands work to two kinds of subagent, and this page explains both.
// Subagents are the engine's general-purpose `general` agent, which the main
// agent starts on its own for big tasks, one per independent part, in
// parallel; small tasks it does itself. Subagent specialists are every other
// agent, each with one focus; user-defined agents count as specialists too.
// The page has one control, the General subagents switch, which writes
// `agent.general.disable` to the connected engine's global config. It reads
// that config through its own query, so it waits for the saved value instead
// of showing the default, and it asks first when a change would stop running
// sessions. Specialists have no controls: the engine defines them and routes
// on their descriptions. No directory store is needed, so the page works
// where none exists.

const SUBAGENT_FACTS = [
  {
    title: "When Vector uses them",
    description:
      "For big tasks: three or more files split across parts that do not depend on each other, or broad research as well as changes. A one-file change, a quick fix, a short question, or two or three closely linked files it does itself.",
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

// Saving the switch reloads the engine's state, which stops every running
// session, so the page asks first whenever something is working.
function DialogStopRunningWork(props: { count: number; enable: boolean; onConfirm: () => void }) {
  const dialog = useDialog()
  return (
    <Dialog
      title={props.enable ? "Turn general subagents on?" : "Turn general subagents off?"}
      description={stopWorkDescription(props.count)}
      fit
    >
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
  const specialists = () => Object.values(SUBAGENT_IDENTITIES).filter((identity) => identity.id !== GENERAL_SUBAGENT_ID)

  // The saved value is the engine's global config. This query shares its
  // cache with server sync, so it refreshes after a save, and unlike
  // serverSync().data.config, which is {} until the config arrives and so
  // reads as "on", it says whether the saved value is actually known.
  const configQuery = useQuery(() => serverSync().queryOptions.globalConfig())
  const loaded = () => configQuery.data !== undefined
  const saved = () => generalSubagentsEnabled(configQuery.data ?? {})
  // While an update is in flight, and until the refetched config agrees with
  // it, the switch shows what the user picked instead of flicking back.
  const [pending, setPending] = createSignal<boolean>()
  const enabled = () => pending() ?? saved()
  const saving = () => serverSync().data.reload === "pending"
  createEffect(() => {
    const next = pending()
    if (next !== undefined && loaded() && saved() === next) setPending(undefined)
  })
  const save = (next: boolean) => {
    setPending(next)
    void serverSync()
      .updateConfig(generalSubagentsPatch(next))
      .catch((err: unknown) => {
        setPending(undefined)
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
  }
  const setEnabled = (next: boolean) => {
    if (next === enabled()) return
    const count = runningSessions(serverSync().session.data.session_status)
    if (count === 0) return save(next)
    void dialog.show(() => <DialogStopRunningWork count={count} enable={next} onConfirm={() => save(next)} />)
  }

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
              <Show
                when={loaded()}
                fallback={
                  <span class="settings-v2-row-description">
                    {configQuery.isError
                      ? "Could not read this setting. Reopen Settings to try again."
                      : language.t("common.loading")}
                  </span>
                }
              >
                <Switch checked={enabled()} disabled={saving()} onChange={setEnabled} hideLabel>
                  General subagents
                </Switch>
              </Show>
            </div>
          </div>
          <div class="settings-v2-row-modern settings-v2-row-modern--stacked">
            <div class="settings-v2-row-copy">
              <div class="settings-v2-row-title">In the terminal</div>
              <div class="settings-v2-row-description">
                The terminal reads its own config file. To turn subagents off there, set agent.general.disable to true
                in ~/.config/vector/opencode.json {"(%USERPROFILE%\\.config\\vector\\opencode.json on Windows)"}. It
                takes effect the next time you start Vector in the terminal. The same setting in a project's
                opencode.json turns them off for that project everywhere, whatever this switch says.
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
          <div class="settings-v2-pets-grid">
            <For each={specialists()}>
              {(identity) => (
                <div class="settings-v2-pet">
                  <SubagentAvatar id={identity.id} size={34} />
                  <div class="settings-v2-pet-copy">
                    <div class="settings-v2-pet-name">
                      {identity.name}
                      <span class="settings-v2-pet-species">{identity.summary}</span>
                      <Show when={identity.readOnly}>
                        <span class="settings-v2-pet-badge">read-only</span>
                      </Show>
                    </div>
                    <div class="settings-v2-pet-role">{identity.detail}</div>
                    <div class="settings-v2-pet-id">{identity.id}</div>
                  </div>
                </div>
              )}
            </For>
          </div>
          <p class="settings-v2-row-description">
            Explore, Review, Security and Judge can read your project and run checks, but cannot edit it. In Plan mode,
            Vector uses only Explore, Review and Security. Agents you define yourself count as subagent specialists too.
            All of them keep working when General subagents is off.
          </p>
        </div>
      </div>
    </section>
  )
}
