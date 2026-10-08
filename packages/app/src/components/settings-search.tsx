import { Button } from "@vectordevai/ui/button"
import { TextField } from "@vectordevai/ui/text-field"
import { createEffect, createResource, createSignal, For, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"

export function SettingsSearch() {
  return (
    <section class="settings-form-section flex flex-col gap-4" aria-labelledby="search-settings-title">
      <div>
        <h3 id="search-settings-title" class="text-14-medium text-text-strong">
          Web search
        </h3>
        <p class="text-12-regular text-text-weak mt-1">
          Connect your own search account to enable web search. Keys are stored with your provider credentials on the
          selected server. EXA_API_KEY and PARALLEL_API_KEY environment variables take precedence.
        </p>
      </div>
      <For each={["exa", "parallel"] as const}>{(provider) => <SearchKey provider={provider} />}</For>
    </section>
  )
}

function SearchKey(props: { provider: "exa" | "parallel" }) {
  const sdk = useServerSDK()
  const [key, setKey] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [saved, { refetch }] = createResource(
    () => sdk().client,
    async (client) => (await client.auth.exists({ providerID: props.provider }, { throwOnError: true })).data === true,
  )
  const hasKey = () => !saved.error && saved()
  createEffect(() => {
    sdk().client
    setKey("")
  })
  const name = () => (props.provider === "exa" ? "Exa" : "Parallel")
  const change = async (remove: boolean) => {
    if (pending() || (!remove && !key().trim())) return
    const client = sdk().client
    setPending(true)
    await (
      remove
        ? client.auth.remove({ providerID: props.provider }, { throwOnError: true })
        : client.auth.set(
            { providerID: props.provider, auth: { type: "api", key: key().trim() } },
            { throwOnError: true },
          )
    )
      .then(async () => {
        setKey("")
        await refetch()
        await client.global.dispose()
        showToast({ title: `${name()} key ${remove ? "removed" : "saved"}`, variant: "success" })
      })
      .catch(() => showToast({ title: `Could not ${remove ? "remove" : "save"} the ${name()} key. Try again.` }))
      .finally(() => setPending(false))
  }
  return (
    <form
      class="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void change(false)
      }}
    >
      <div class="min-w-[240px] max-w-[440px] flex-1">
        <TextField
          type="password"
          autocomplete="new-password"
          label={`${name()} API key`}
          placeholder={hasKey() ? "A key is saved. Enter a new key to replace it." : `Enter your ${name()} API key`}
          value={key()}
          onChange={setKey}
          disabled={pending()}
        />
      </div>
      <Button type="submit" disabled={pending() || !key().trim()}>
        {hasKey() ? "Replace key" : "Save key"}
      </Button>
      <Show when={hasKey()}>
        <Button type="button" variant="ghost" disabled={pending()} onClick={() => void change(true)}>
          Remove key
        </Button>
      </Show>
      <Show when={saved.error}>
        <p class="basis-full text-12-regular text-text-weak">Could not check saved-key status.</p>
      </Show>
    </form>
  )
}
