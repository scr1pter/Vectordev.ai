import { type Accessor, Component, Show } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tag } from "@opencode-ai/ui/tag"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { DialogConnectProvider } from "./dialog-connect-provider"
import { useLanguage } from "@/context/language"
import { DialogCustomProvider } from "./dialog-custom-provider"

const CUSTOM_ID = "_custom"
const OPENCODE_PROVIDER_IDS = new Set(["opencode", "opencode-go", "opencode-zen"])
const HIDDEN_PROVIDER_IDS = new Set<string>()

const isOpenCodeProvider = (id: string) => OPENCODE_PROVIDER_IDS.has(id)

const providerDisplayName = (id: string, name: string) => {
  if (id === "opencode") return name || "OpenCode"
  if (id === "opencode-go") return name || "OpenCode Go"
  if (id === "opencode-zen") return name || "OpenCode Zen"
  return name
}

export const DialogSelectProvider: Component<{ directory?: Accessor<string | undefined> }> = (props) => {
  const dialog = useDialog()
  const providers = useProviders(props.directory)
  const language = useLanguage()

  const popularGroup = () => language.t("dialog.provider.group.popular")
  const otherGroup = () => language.t("dialog.provider.group.other")
  const customLabel = () => language.t("settings.providers.tag.custom")
  const note = (id: string) => {
    if (id === "opencode") return "Free starter models provided by OpenCode and available inside Vector."
    if (id === "opencode-go") return "OpenCode Go models are provided by OpenCode and can be used inside Vector."
    if (id === "opencode-zen") return "OpenCode Zen models are provided by OpenCode and can be used inside Vector."
    if (id === "anthropic") return language.t("dialog.provider.anthropic.note")
    if (id === "openai") return language.t("dialog.provider.openai.note")
    if (id.startsWith("github-copilot")) return language.t("dialog.provider.copilot.note")
  }

  return (
    <Dialog title={language.t("command.provider.connect")} transition>
      <div class="px-4 pt-3 pb-1 text-12-medium text-text-base">Models provided by Vector:</div>
      <List
        class="px-3"
        search={{ placeholder: language.t("dialog.provider.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.provider.empty")}
        activeIcon="plus-small"
        key={(x) => x?.id}
        items={() => {
          language.locale()
          return [{ id: CUSTOM_ID, name: customLabel() }, ...providers.all().values()].filter(
            (provider) => provider.id === CUSTOM_ID || !HIDDEN_PROVIDER_IDS.has(provider.id),
          )
        }}
        filterKeys={["id", "name"]}
        groupBy={(x) => (popularProviders.includes(x.id) ? popularGroup() : otherGroup())}
        sortBy={(a, b) => {
          if (a.id === CUSTOM_ID) return -1
          if (b.id === CUSTOM_ID) return 1
          if (popularProviders.includes(a.id) && popularProviders.includes(b.id))
            return popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id)
          return providerDisplayName(a.id, a.name).localeCompare(providerDisplayName(b.id, b.name))
        }}
        sortGroupsBy={(a, b) => {
          const popular = popularGroup()
          if (a.category === popular && b.category !== popular) return -1
          if (b.category === popular && a.category !== popular) return 1
          return 0
        }}
        onSelect={(x) => {
          if (!x) return
          if (x.id === CUSTOM_ID) {
            dialog.show(() => <DialogCustomProvider back="providers" directory={props.directory} />)
            return
          }
          dialog.show(() => <DialogConnectProvider provider={x.id} directory={props.directory} />)
        }}
      >
        {(i) => (
          <div class="px-1.25 w-full flex items-center gap-x-3">
            <ProviderIcon data-slot="list-item-extra-icon" id={i.id} />
            <span>{providerDisplayName(i.id, i.name)}</span>
            <Show when={isOpenCodeProvider(i.id)}>
              <div class="text-14-regular text-text-weak">{note(i.id)}</div>
            </Show>
            <Show when={i.id === CUSTOM_ID}>
              <Tag>{language.t("settings.providers.tag.custom")}</Tag>
            </Show>
            <Show when={isOpenCodeProvider(i.id)}>
              <Tag>{language.t("dialog.provider.tag.recommended")}</Tag>
            </Show>
            <Show when={!isOpenCodeProvider(i.id) && note(i.id)}>
              {(value) => <div class="text-14-regular text-text-weak">{value()}</div>}
            </Show>
          </div>
        )}
      </List>
    </Dialog>
  )
}
