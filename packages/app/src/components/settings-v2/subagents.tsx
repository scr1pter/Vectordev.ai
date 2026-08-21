import { For, Show } from "solid-js"
import { SUBAGENT_IDENTITIES, SubagentAvatar } from "@/features/agents/identities"

// A read-only list of the specialists Vector delegates to. They are not
// configurable — the engine defines them and routes on their descriptions — so
// this shows what each does rather than offering controls that do nothing.
export function SettingsSubagentsV2() {
  const crew = () => Object.values(SUBAGENT_IDENTITIES)

  return (
    <section class="settings-v2-page">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Subagents</p>
          <h2 class="settings-v2-page-title">The specialists Vector delegates to</h2>
          <p class="settings-v2-page-subtitle">
            When Vector hands off part of a task, one of these takes it. Each has its own focus and its own
            permissions, and you will see which one worked by name in the session timeline.
          </p>
        </div>
      </div>

      <div class="settings-v2-card settings-v2-card--wide">
        <div class="settings-v2-card-body">
          <div class="settings-v2-pets-grid">
            <For each={crew()}>
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
        </div>
      </div>
    </section>
  )
}
