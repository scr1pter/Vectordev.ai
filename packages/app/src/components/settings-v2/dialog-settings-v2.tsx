import { Component, For, Show, createMemo, createSignal } from "solid-js"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2 } from "./general"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import { SettingsServersV2 } from "./servers"
import { SettingsUsageV2 } from "./usage"
import { SettingsBillingV2 } from "./billing"
import { SettingsAboutV2 } from "./about"
import { SettingsVoiceV2 } from "./voice"
import { SettingsPersonalizationV2 } from "./personalization"
import { SettingsRulesV2 } from "./rules"
import { SettingsSubagentsV2 } from "./subagents"
import {
  filterSettingsGroups,
  isSettingsTab,
  settingsGroups,
  settingsItemCount,
  type SettingsTab,
} from "./settings-registry"
import "./settings-v2.css"
import "./settings-workspace.css"

export type SettingsWorkspaceProps = {
  sessionID?: string
  section?: SettingsTab
  repositoryPath?: string
  onBack?: () => void
  class?: string
}

/**
 * The settings application surface. It deliberately has no dialog dependency,
 * so desktop routes and workspace tabs can mount it as a first-class full-page
 * destination while the legacy dialog entry point can keep using the same UI.
 */
export const SettingsWorkspace: Component<SettingsWorkspaceProps> = (props) => {
  const platform = usePlatform()
  let searchInput: HTMLInputElement | undefined
  const [query, setQuery] = createSignal("")
  const [section, setSection] = createSignal<SettingsTab>(props.section ?? "general")
  const groups = createMemo(() => filterSettingsGroups(query()))
  const resultCount = createMemo(() => settingsItemCount(groups()))
  const visibleItems = createMemo(() => new Set(groups().flatMap((group) => group.items.map((item) => item.value))))

  const panel = (item: SettingsTab) => {
    if (item === "usage") return <SettingsUsageV2 />
    if (item === "billing") return <SettingsBillingV2 />
    if (item === "about") return <SettingsAboutV2 />
    if (item === "voice") return <SettingsVoiceV2 />
    if (item === "personalization") return <SettingsPersonalizationV2 />
    if (item === "rules") return <SettingsRulesV2 repositoryPath={props.repositoryPath} />
    if (item === "subagents") return <SettingsSubagentsV2 />
    if (item === "providers") return <SettingsProvidersV2 />
    if (item === "models") return <SettingsModelsV2 />
    if (item === "servers") return <SettingsServersV2 />
    return <SettingsGeneralV2 section={item} sessionID={props.sessionID} />
  }

  return (
    <div class={`settings-v2-workspace ${props.class ?? ""}`}>
      <TabsV2
        orientation="vertical"
        variant="settings"
        value={section()}
        onChange={(value) => {
          if (isSettingsTab(value)) setSection(value)
        }}
        class="settings-v2 settings-v2--fullscreen"
      >
        <TabsV2.List>
          <aside class="settings-v2-nav-shell" aria-label="Settings categories">
            <div class="settings-v2-nav-topline">
              <Show when={props.onBack}>
                <button type="button" class="settings-v2-back" aria-label="Back" onClick={props.onBack}>
                  <Icon name="arrow-left" size="small" />
                  <span>Back</span>
                </button>
              </Show>
            </div>

            <div class="settings-v2-brand-row">
              <img src="/vector-logo.png" alt="" class="settings-v2-brand-mark" />
              <div>
                <div class="settings-v2-brand-name">Vector</div>
                <div class="settings-v2-brand-subtitle">Settings</div>
              </div>
            </div>

            <label class="settings-v2-nav-search">
              <Icon name="magnifying-glass" size="small" />
              <input
                ref={searchInput}
                type="search"
                value={query()}
                onInput={(event) => {
                  const value = event.currentTarget.value
                  const start = event.currentTarget.selectionStart ?? value.length
                  const end = event.currentTarget.selectionEnd ?? value.length
                  setQuery(value)
                  queueMicrotask(() => {
                    searchInput?.focus()
                    searchInput?.setSelectionRange(start, end)
                  })
                }}
                placeholder="Search settings"
                aria-label="Search settings"
                autofocus
              />
              <Show when={query()}>
                <button type="button" aria-label="Clear settings search" onClick={() => setQuery("")}>
                  <Icon name="close-small" size="small" />
                </button>
              </Show>
            </label>

            <div class="settings-v2-nav-groups">
              <For each={settingsGroups}>
                {(group) => (
                  <div
                    class="settings-v2-nav-group"
                    classList={{ "settings-v2-nav-group--hidden": !!query().trim() && !group.items.some((item) => visibleItems().has(item.value)) }}
                  >
                    <TabsV2.SectionTitle>{group.title}</TabsV2.SectionTitle>
                    <div class="settings-v2-nav-items">
                      <For each={group.items}>
                        {(item) => (
                          <TabsV2.Trigger
                            value={item.value}
                            classList={{ "settings-v2-nav-item--hidden": !!query().trim() && !visibleItems().has(item.value) }}
                          >
                            <Icon name={item.icon} />
                            {item.label}
                          </TabsV2.Trigger>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
              <Show when={query() && resultCount() === 0}>
                <div class="settings-v2-nav-empty">
                  <strong>No settings found</strong>
                  <span>Try a feature name such as model, memory, update, or notifications.</span>
                </div>
              </Show>
            </div>

            <div class="settings-v2-nav-footer">
              <span>Vector {platform.version || "Development"}</span>
              <span>{platform.platform === "desktop" ? "Desktop" : "Web"}</span>
            </div>
          </aside>
        </TabsV2.List>

        <For each={filterSettingsGroups("").flatMap((group) => group.items)}>
          {(item) => (
            <TabsV2.Content value={item.value} class="settings-v2-panel">
              {panel(item.value)}
            </TabsV2.Content>
          )}
        </For>
      </TabsV2>
    </div>
  )
}

export const DialogSettings: Component<Omit<SettingsWorkspaceProps, "onBack">> = (props) => {
  const dialog = useDialog()

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <SettingsWorkspace {...props} onBack={() => dialog.close()} />
    </Dialog>
  )
}
