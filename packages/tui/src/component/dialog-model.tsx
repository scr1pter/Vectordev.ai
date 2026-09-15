import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useSync } from "../context/sync"
import { includedModelName, isIncluded } from "../util/included-model"

export { includedModelName, isIncluded } from "../util/included-model"

/** Models included with Vector (isIncluded) share one section, as in the desktop app. */
const INCLUDED_CATEGORY = "Models included with Vector"
const INCLUDED_FOOTER = "Included"

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")

  const connected = useConnected()
  const providers = createDialogProviderOptions()

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((provider) => provider.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        const included = isIncluded(provider, model)
        const title = model.name ?? item.modelID
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: included ? includedModelName(title) : title,
            // The footer already says where an included model comes from.
            description: included ? undefined : provider.name,
            category,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: included ? INCLUDED_FOOTER : undefined,
            onSelect: () => {
              onSelect(provider.id, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => {
            const included = isIncluded(provider, info)
            const title = info.name ?? model
            return {
              value: { providerID: provider.id, modelID: model },
              title: included ? includedModelName(title) : title,
              releaseDate: info.release_date,
              description: favorites.some((item) => item.providerID === provider.id && item.modelID === model)
                ? "(Favorite)"
                : undefined,
              // Users with no key get the heading too: they're who it's for.
              category: included ? INCLUDED_CATEGORY : connected() ? provider.name : undefined,
              // What search reads (searchModelOptions): the catalogue name and, once a provider
              // is connected, its name. Never the heading.
              searchName: title,
              searchProvider: connected() ? provider.name : undefined,
              disabled: provider.id === "opencode" && model.includes("-nano"),
              footer: included ? INCLUDED_FOOTER : undefined,
              onSelect() {
                onSelect(provider.id, model)
              },
            }
          }),
          filter((option) => {
            if (!showSections) return true
            if (
              favorites.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            if (
              recents.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            return true
          }),
          (options) => sortModelOptions(options, props.providerID !== undefined),
        ),
      ),
    )

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: "Popular providers",
          })),
          take(6),
        )
      : []

    if (needle) {
      return [
        ...searchModelOptions(needle, providerOptions),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    return [...favoriteOptions, ...recentOptions, ...providerOptions, ...popularProviders]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((item) => item.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  function onSelect(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      actions={[
        {
          command: "model.dialog.provider",
          title: connected() ? "Connect provider" : "View all providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          command: "model.dialog.favorite",
          title: "Favorite",
          hidden: !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}

/** Search finds a row by its catalogue name, so "free" still finds the included models, and,
    once a provider is connected, by the provider's name. Never by the section heading: its
    letters would pull in rows that don't match, and the cursor lands on the first row. Included
    rows come first, as when browsing. */
export function searchModelOptions<
  T extends {
    searchName: string
    searchProvider?: string
    footer?: string
    releaseDate: string | number
    title: string
  },
>(needle: string, options: T[]) {
  return sortModelOptions(
    fuzzysort.go(needle, options, { keys: ["searchName", "searchProvider"] }).map((x) => x.obj),
    false,
  )
}

export function sortModelOptions<T extends { footer?: string; releaseDate: string | number; title: string }>(
  options: T[],
  newestFirst: boolean,
) {
  if (newestFirst) return sortBy(options, [(option) => option.releaseDate, "desc"], (option) => option.title)
  return sortBy(
    options,
    (option) => option.footer !== INCLUDED_FOOTER,
    [(option) => option.releaseDate, "desc"],
    (option) => option.title,
  )
}
