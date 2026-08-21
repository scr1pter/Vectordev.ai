import { For } from "solid-js"
import { SUBAGENT_IDENTITIES, SubagentAvatar } from "@/features/agents/identities"

// A read-only showcase of the specialists Vector delegates to. They are not
// configurable — the engine defines them and routes on their descriptions — so
// this shows who they are rather than offering controls that do nothing.
export function SettingsPetsV2() {
  const crew = () => Object.values(SUBAGENT_IDENTITIES)

  return (
    <section class="settings-v2-page">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Pets</p>
          <h2 class="settings-v2-page-title">The crew Vector delegates to</h2>
          <p class="settings-v2-page-subtitle">
            When Vector hands off part of a task, one of these specialists takes it. Each has its own focus and its
            own permissions — you will see them by name in the session timeline.
          </p>
        </div>
      </div>

      <div class="settings-v2-card settings-v2-card--wide">
        <div class="settings-v2-card-body">
          <div class="settings-v2-pets-grid">
            <For each={crew()}>
              {(identity) => (
                <div class="settings-v2-pet">
                  <SubagentAvatar id={identity.id} size={40} />
                  <div class="settings-v2-pet-copy">
                    <div class="settings-v2-pet-name">
                      {identity.petName}
                      <span class="settings-v2-pet-species">the {identity.species}</span>
                    </div>
                    <div class="settings-v2-pet-tagline">“{identity.tagline}”</div>
                    <div class="settings-v2-pet-role">{identity.role}</div>
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
