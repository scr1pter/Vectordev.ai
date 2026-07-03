import { Component } from "solid-js"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2 } from "./general"
import { SettingsKeybinds } from "../settings-keybinds"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import "./settings-v2.css"
import { SettingsServersV2 } from "./servers"
import { SettingsCapabilityPanelV2, capabilityPages } from "./capability-panel"

export const DialogSettings: Component<{
  sessionID?: string
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <TabsV2 orientation="vertical" variant="settings" defaultValue="general" class="settings-v2">
        <TabsV2.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>Vector</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="general">
                      <Icon name="sliders" />
                      Configuration
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      Keyboard shortcuts
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="usage">
                      <Icon name="models" />
                      Usage and billing
                    </TabsV2.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>Integrations</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="appshots">
                      <Icon name="server" />
                      Appshots
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="mcp">
                      <Icon name="providers" />
                      MCP servers
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="browser">
                      <Icon name="server" />
                      Browser
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="computer">
                      <Icon name="models" />
                      Computer use
                    </TabsV2.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>Coding</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="hooks">
                      <Icon name="providers" />
                      Hooks
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="providers">
                      <Icon name="providers" />
                      Connections
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="models">
                      <Icon name="models" />
                      Models
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="git">
                      <Icon name="providers" />
                      Git
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="servers">
                      <Icon name="server" />
                      Environments
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="worktrees">
                      <Icon name="server" />
                      Worktrees
                    </TabsV2.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>Archived</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="archived">
                      <Icon name="models" />
                      Archived chats
                    </TabsV2.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="settings-v2-nav-footer">
              <span>{language.t("app.name.desktop")}</span>
              <span>v{platform.version}</span>
            </div>
          </div>
        </TabsV2.List>
        <TabsV2.Content value="general" class="settings-v2-panel">
          <SettingsGeneralV2 sessionID={props.sessionID} />
        </TabsV2.Content>
        <TabsV2.Content value="shortcuts" class="settings-v2-panel">
          <SettingsKeybinds v2 />
        </TabsV2.Content>
        <TabsV2.Content value="usage" class="settings-v2-panel">
          <SettingsCapabilityPanelV2 {...capabilityPages.usage} />
        </TabsV2.Content>
        <TabsV2.Content value="appshots" class="settings-v2-panel">
          <SettingsCapabilityPanelV2 {...capabilityPages.appshots} />
        </TabsV2.Content>
        <TabsV2.Content value="mcp" class="settings-v2-panel">
          <SettingsCapabilityPanelV2 {...capabilityPages.mcp} />
        </TabsV2.Content>
        <TabsV2.Content value="browser" class="settings-v2-panel">
          <SettingsCapabilityPanelV2 {...capabilityPages.browser} />
        </TabsV2.Content>
        <TabsV2.Content value="computer" class="settings-v2-panel">
          <SettingsCapabilityPanelV2 {...capabilityPages.computer} />
        </TabsV2.Content>
        <TabsV2.Content value="hooks" class="settings-v2-panel">
          <SettingsCapabilityPanelV2 {...capabilityPages.hooks} />
        </TabsV2.Content>
        <TabsV2.Content value="servers" class="settings-v2-panel">
          <SettingsServersV2 />
        </TabsV2.Content>
        <TabsV2.Content value="providers" class="settings-v2-panel">
          <SettingsProvidersV2 />
        </TabsV2.Content>
        <TabsV2.Content value="models" class="settings-v2-panel">
          <SettingsModelsV2 />
        </TabsV2.Content>
        <TabsV2.Content value="git" class="settings-v2-panel">
          <SettingsCapabilityPanelV2 {...capabilityPages.git} />
        </TabsV2.Content>
        <TabsV2.Content value="worktrees" class="settings-v2-panel">
          <SettingsCapabilityPanelV2 {...capabilityPages.worktrees} />
        </TabsV2.Content>
        <TabsV2.Content value="archived" class="settings-v2-panel">
          <SettingsCapabilityPanelV2 {...capabilityPages.archived} />
        </TabsV2.Content>
      </TabsV2>
    </Dialog>
  )
}
