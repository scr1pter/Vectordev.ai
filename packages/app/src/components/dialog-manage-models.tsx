import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog as DialogV2, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Switch as SwitchV2 } from "@opencode-ai/ui/v2/switch-v2"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import { For, Show, type Component } from "solid-js"
import { useLocal } from "@/context/local"
import { useModels } from "@/context/models"
import { popularProviders } from "@/hooks/use-providers"
import { useLanguage } from "@/context/language"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectProvider } from "./dialog-select-provider"
import { decode64 } from "@/utils/base64"
import { brandProviderName } from "@/utils/provider-brand"
import { SettingsListV2 } from "./settings-v2/parts/list"
import { SettingsRowV2 } from "./settings-v2/parts/row"
import "./settings-v2/settings-v2.css"

type ModelItem = ReturnType<ReturnType<typeof useLocal>["model"]["list"]>[number]

const HIDDEN_PROVIDER_IDS = new Set<string>()

const providerDisplayName = (id: string, name: string) => brandProviderName(id, name)

export const DialogManageModelsV2: Component = () => {
  // Works both inside a project (chat) and at the shell level (e.g. Parallel
  // Workspaces), where the directory-scoped Local context does not exist.
  const local = (() => {
    try {
      return useLocal()
    } catch {
      return undefined
    }
  })()
  const models = useModels()
  const language = useLanguage()
  const dialog = useDialog()
  const directory = () => (local ? decode64(local.slug()) : undefined)

  const handleConnectProvider = () => {
    dialog.show(() => <DialogSelectProvider directory={directory} />)
  }
  const visibleModels = () => models.list().filter((x) => !HIDDEN_PROVIDER_IDS.has(x.provider.id))
  const providerList = (providerID: string) => visibleModels().filter((x) => x.provider.id === providerID)
  const providerVisible = (providerID: string) =>
    providerList(providerID).every((x) => models.visible({ modelID: x.id, providerID: x.provider.id }))
  const setProviderVisibility = (providerID: string, checked: boolean) => {
    providerList(providerID).forEach((x) => {
      models.setVisibility({ modelID: x.id, providerID: x.provider.id }, checked)
    })
  }
  const setModelVisibility = (item: ModelItem, checked: boolean) => {
    models.setVisibility({ modelID: item.id, providerID: item.provider.id }, checked)
  }
  const list = useFilteredList<ModelItem>({
    items: visibleModels,
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aRank = popularProviders.indexOf(a.category)
      const bRank = popularProviders.indexOf(b.category)
      const aPopular = aRank >= 0
      const bPopular = bRank >= 0
      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      return aRank - bRank
    },
  })

  return (
    <DialogV2 size="large" variant="settings" class="settings-v2-dialog">
      <DialogHeader hideClose={true} closeLabel={language.t("common.close")}>
        <DialogTitleGroup
          title={language.t("dialog.model.manage")}
          description={language.t("dialog.model.manage.description")}
        />
        <ButtonV2 variant="neutral" icon="plus" onClick={handleConnectProvider}>
          {language.t("command.provider.connect")}
        </ButtonV2>
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-1 flex-col">
        <div class="px-4 pt-px pb-3">
          <div class="relative">
            <TextInputV2
              type="search"
              appearance="base"
              class="!w-full self-stretch"
              value={list.filter()}
              onInput={(event) => list.onInput(event.currentTarget.value)}
              placeholder={language.t("dialog.model.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              autofocus
              aria-label={language.t("dialog.model.search.placeholder")}
            />
            <Show when={list.filter()}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                class="settings-v2-tab-search-clear"
                icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
                onClick={() => list.clear()}
                aria-label={language.t("common.clear")}
              />
            </Show>
          </div>
        </div>
        <div data-slot="manage-models-scroll" class="relative min-h-0 flex-1">
          <div class="settings-v2-panel settings-v2-models h-full px-4 pt-4 pb-4">
            <Show
              when={!list.grouped.loading}
              fallback={
                <div class="settings-v2-models-status">
                  {language.t("common.loading")}
                  {language.t("common.loading.ellipsis")}
                </div>
              }
            >
              <Show
                when={list.flat().length > 0}
                fallback={
                  <div class="settings-v2-models-status">
                    <span>{language.t("dialog.model.empty")}</span>
                    <Show when={list.filter()}>
                      <span class="settings-v2-models-status-filter">&quot;{list.filter()}&quot;</span>
                    </Show>
                  </div>
                }
              >
                <For each={list.grouped.latest}>
                  {(group) => (
                    <div class="settings-v2-section" data-component="settings-models-provider">
                      <div class="settings-v2-models-group-header justify-between">
                        <div class="flex min-w-0 items-center gap-2">
                          <ProviderIcon id={group.category} width={16} height={16} class="ml-4 shrink-0" />
                          <h3 class="settings-v2-section-title">
                            {providerDisplayName(group.items[0].provider.id, group.items[0].provider.name)}
                          </h3>
                        </div>
                        <div>
                          <SwitchV2
                            class="mr-6"
                            checked={providerVisible(group.category)}
                            onChange={(checked) => setProviderVisibility(group.category, checked)}
                            hideLabel
                          >
                            {providerDisplayName(group.items[0].provider.id, group.items[0].provider.name)}
                          </SwitchV2>
                        </div>
                      </div>
                      <SettingsListV2>
                        <For each={group.items}>
                          {(item) => (
                            <SettingsRowV2 title={item.name} description="">
                              <div>
                                <SwitchV2
                                  checked={models.visible({ modelID: item.id, providerID: item.provider.id })}
                                  onChange={(checked) => setModelVisibility(item, checked)}
                                  hideLabel
                                >
                                  {item.name}
                                </SwitchV2>
                              </div>
                            </SettingsRowV2>
                          )}
                        </For>
                      </SettingsListV2>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </div>
      </DialogBody>
    </DialogV2>
  )
}
