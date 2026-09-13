import "@/features/background-tasks/background-tasks.css"
import { For, Show } from "solid-js"
import { GENERAL_SUBAGENT_ID } from "@opencode-ai/session-ui/subagent-identity"
import { SUBAGENT_IDENTITIES, SubagentAvatar } from "@/features/agents/identities"

// Vector hands work to two kinds of subagent, and this page explains both.
// Subagents are the engine's general-purpose `general` agent, which the main
// agent starts on its own, as many as a task needs, in parallel. Subagent
// specialists are every other agent, each with one focus; user-defined agents
// count as specialists too. Neither kind is configurable here: the engine
// defines them and routes on their descriptions, so the page shows what each
// does rather than offering controls that do nothing. It stays static because
// settings can open where no directory store exists.

const SUBAGENT_FACTS = [
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
    description: "No cap. When more than six are running at once, Vector tells you how many.",
  },
  {
    title: "How deep",
    description: "Delegation stops two levels below your session.",
  },
] as const

const LEGEND = [
  { status: "running", label: "Running" },
  { status: "waiting", label: "Waiting on you" },
  { status: "done", label: "Done" },
  { status: "failed", label: "Failed" },
  { status: "pending", label: "Not started" },
] as const

export function SettingsSubagentsV2() {
  const specialists = () => Object.values(SUBAGENT_IDENTITIES).filter((identity) => identity.id !== GENERAL_SUBAGENT_ID)

  return (
    <section class="settings-v2-page">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Subagents</p>
          <h2 class="settings-v2-page-title">Subagents and subagent specialists</h2>
          <p class="settings-v2-page-subtitle">
            Vector's agent can hand parts of a task to other agents and keep working. There are two kinds, and you will
            see both in the chat and in Background tasks.
          </p>
        </div>
      </div>

      <div class="settings-v2-card settings-v2-card--wide">
        <div class="settings-v2-card-head" style={{ "grid-template-columns": "1fr" }}>
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">Subagents</h3>
            <p class="settings-v2-card-description">
              General-purpose agents that Vector's agent starts on its own. It starts as many as a task needs and runs
              them at the same time. There is no cap.
            </p>
          </div>
        </div>
        <div class="settings-v2-card-body">
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
          </p>
        </div>
      </div>
    </section>
  )
}
