import { Component, For } from "solid-js"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2, type SettingsSection } from "./general"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import { SettingsServersV2 } from "./servers"
import "./settings-v2.css"

type SettingsTab = SettingsSection | "providers" | "models" | "servers"

const groups: {
  title: string
  items: { value: SettingsTab; label: string; icon: IconProps["name"] }[]
}[] = [
  {
    title: "General",
    items: [
      { value: "general", label: "General", icon: "sliders" },
      { value: "appearance", label: "Appearance", icon: "photo" },
      { value: "profile", label: "Profile", icon: "prompt" },
      { value: "personalization", label: "Instructions", icon: "brain" },
    ],
  },
  {
    title: "Models & keys",
    items: [
      { value: "providers", label: "Providers", icon: "providers" },
      { value: "models", label: "Models", icon: "models" },
    ],
  },
  {
    title: "Workspace",
    items: [
      { value: "shortcuts", label: "Shortcuts", icon: "keyboard" },
      { value: "editor", label: "Editor", icon: "code" },
      { value: "chat", label: "Chat", icon: "bubble-5" },
    ],
  },
  {
    title: "System",
    items: [
      { value: "servers", label: "Servers", icon: "server" },
      { value: "notifications", label: "Notifications", icon: "status" },
      { value: "accessibility", label: "Accessibility", icon: "glasses" },
      { value: "about", label: "About Vector", icon: "help" },
    ],
  },
]

export const DialogSettings: Component<{
  sessionID?: string
  section?: SettingsTab
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()

  const panel = (item: SettingsTab) => {
    if (item === "providers") return <SettingsProvidersV2 />
    if (item === "models") return <SettingsModelsV2 />
    if (item === "servers") return <SettingsServersV2 />
    return <SettingsGeneralV2 section={item} sessionID={props.sessionID} />
  }

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <TabsV2 orientation="vertical" variant="settings" defaultValue={props.section ?? "general"} class="settings-v2">
        <TabsV2.List>
          <div class="settings-v2-nav-shell">
            <div class="settings-v2-brand-row">
              <img src="/vector-logo.png" alt="" class="settings-v2-brand-mark" />
              <div>
                <div class="settings-v2-brand-name">Vector</div>
                <div class="settings-v2-brand-subtitle">Workspace settings</div>
              </div>
            </div>
            <div class="settings-v2-nav-groups">
              <For each={groups}>
                {(group) => (
                  <div class="settings-v2-nav-group">
                    <TabsV2.SectionTitle>{group.title}</TabsV2.SectionTitle>
                    <div class="settings-v2-nav-items">
                      <For each={group.items}>
                        {(item) => (
                          <TabsV2.Trigger value={item.value}>
                            <Icon name={item.icon} />
                            {item.label}
                          </TabsV2.Trigger>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>
            <div class="settings-v2-nav-footer">
              <span>{language.t("app.name.desktop")}</span>
              <span>Build {platform.version}</span>
            </div>
          </div>
        </TabsV2.List>
        <For each={groups.flatMap((group) => group.items)}>
          {(item) => (
            <TabsV2.Content value={item.value} class="settings-v2-panel">
              {panel(item.value)}
            </TabsV2.Content>
          )}
        </For>
      </TabsV2>
    </Dialog>
  )
}
