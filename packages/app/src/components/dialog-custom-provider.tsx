import type { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { Button } from "@vectordevai/ui/button"
import { Checkbox } from "@vectordevai/ui/checkbox"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { Dialog } from "@vectordevai/ui/dialog"
import { IconButton } from "@vectordevai/ui/icon-button"
import { ProviderIcon } from "@vectordevai/ui/provider-icon"
import { useMutation } from "@tanstack/solid-query"
import { TextField } from "@vectordevai/ui/text-field"
import { showToast } from "@/utils/toast"
import { type Accessor, batch, createMemo, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Link } from "@/components/link"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import {
  applyPreset,
  applyServer,
  COPY,
  type FormState,
  headerRow,
  identifyHeaders,
  identity,
  labels,
  modelRow,
  PRESETS,
  type Preset,
  validateCustomProvider,
} from "./dialog-custom-provider-form"
import { saveCustomProvider } from "./dialog-custom-provider-save"
import { DialogSelectProvider } from "./dialog-select-provider"

type Props = {
  back?: "providers" | "close"
  directory?: Accessor<string | undefined>
  /**
   * Find servers: the engine's search of its own computer (loopback only). The dialog shows Find servers only when a
   * caller passes it, since the search runs where the engine runs, not in this window.
   */
  detect?: () => Promise<readonly LocalProbe.Server[]>
  /** Reads the server at a typed address through the engine, for Identify, with the key and headers typed here. */
  identify?: (input: {
    readonly url: string
    readonly headers: Readonly<Record<string, string>>
  }) => Promise<LocalProbe.Server | undefined>
}

type Search = {
  status: "idle" | "looking" | "done" | "failed"
  servers: readonly LocalProbe.Server[]
  message?: string
  skipped: number
}

export function DialogCustomProvider(props: Props) {
  const dialog = useDialog()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const language = useLanguage()

  const [form, setForm] = createStore<FormState>({
    providerID: "",
    name: "",
    baseURL: "",
    apiKey: "",
    models: [modelRow()],
    headers: [headerRow()],
    concurrency: "",
    err: {},
  })
  const [search, setSearch] = createStore<Search>({ status: "idle", servers: [], skipped: 0 })
  const label = createMemo(() => labels(form))

  const existing = () => [
    ...serverSync().data.provider.all.keys(),
    ...serverSync().data.provider.connected,
    ...Object.keys(serverSync().data.config.provider ?? {}),
    ...(serverSync().data.config.disabled_providers ?? []),
  ]

  const pickPreset = (preset: Preset) => {
    setForm(applyPreset(form, preset, existing()))
    setSearch({ skipped: 0, message: undefined })
  }

  const chooseServer = (server: LocalProbe.Server) => {
    const applied = applyServer(form, server, existing())
    setForm(applied.form)
    setSearch({ skipped: applied.skipped })
  }

  const find = async () => {
    if (!props.detect) return
    setSearch({ status: "looking", servers: [], message: undefined })
    const servers = await props.detect().catch(() => undefined)
    if (!servers) return setSearch({ status: "failed", message: "Vector could not look for servers. Try again." })
    setSearch({
      status: "done",
      servers,
      message: servers.length
        ? undefined
        : "No model server answered on this computer. Start one, or type its address.",
    })
    if (servers.length === 1) chooseServer(servers[0])
  }

  const identifyTyped = async () => {
    if (!props.identify || !form.baseURL.trim()) return
    setSearch({ status: "looking", message: undefined })
    const server = await props
      .identify({ url: form.baseURL.trim(), headers: identifyHeaders(form) })
      .catch(() => undefined)
    if (!server) return setSearch({ status: "failed", message: "Nothing Vector recognises answered at this address." })
    setSearch({ status: "done", message: undefined })
    chooseServer(server)
  }

  const goBack = () => {
    if (props.back === "close") {
      dialog.close()
      return
    }
    dialog.show(() => <DialogSelectProvider directory={props.directory} />)
  }

  const addModel = () => {
    setForm(
      "models",
      produce((rows) => {
        rows.push(modelRow())
      }),
    )
  }

  const removeModel = (index: number) => {
    if (form.models.length <= 1) return
    setForm(
      "models",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const addHeader = () => {
    setForm(
      "headers",
      produce((rows) => {
        rows.push(headerRow())
      }),
    )
  }

  const removeHeader = (index: number) => {
    if (form.headers.length <= 1) return
    setForm(
      "headers",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const setField = (key: "providerID" | "name" | "baseURL" | "apiKey" | "concurrency", value: string) => {
    setForm(key, value)
    if (key === "apiKey") return
    setForm("err", key, undefined)
  }

  const setModel = (index: number, key: "id" | "name" | "context" | "output", value: string) => {
    batch(() => {
      setForm("models", index, key, value)
      setForm("models", index, "err", key, undefined)
    })
  }

  const setHeader = (index: number, key: "key" | "value", value: string) => {
    batch(() => {
      setForm("headers", index, key, value)
      setForm("headers", index, "err", key, undefined)
    })
  }

  const setModelFlag = (index: number, key: "tools" | "vision", value: boolean) => {
    setForm("models", index, key, value)
  }

  const validate = () => {
    const output = validateCustomProvider({
      form,
      t: language.t,
      existing: existing(),
    })
    batch(() => {
      setForm("err", output.err)
      output.models.forEach((err, index) => setForm("models", index, "err", err))
      output.headers.forEach((err, index) => setForm("headers", index, "err", err))
    })
    return output.result
  }

  const saveMutation = useMutation(() => ({
    mutationFn: async (result: NonNullable<ReturnType<typeof validate>>) => {
      await saveCustomProvider({
        client: serverSDK().client,
        result,
        directory: props.directory?.(),
        updateConfig: (config) => serverSync().updateConfig(config),
        conflictMessage: language.t("provider.custom.error.providerID.exists"),
      })
      return result
    },
    onSuccess: (result) => {
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.connect.toast.connected.title", { provider: result.name }),
        description: language.t("provider.connect.toast.connected.description", { provider: result.name }),
      })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  const save = (e: SubmitEvent) => {
    e.preventDefault()
    if (saveMutation.isPending) return

    const result = validate()
    if (!result) return
    saveMutation.mutate(result)
  }

  return (
    <Dialog
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={goBack}
          aria-label={language.t("common.goBack")}
        />
      }
      transition
    >
      <div class="flex flex-col gap-6 px-2.5 pb-3 overflow-y-auto max-h-[60vh]">
        <div class="px-2.5 flex gap-4 items-center">
          <ProviderIcon id="synthetic" class="size-5 shrink-0 icon-strong-base" />
          <div class="text-16-medium text-text-strong">{language.t("provider.custom.title")}</div>
        </div>

        <form onSubmit={save} class="px-2.5 pb-6 flex flex-col gap-6">
          <p class="text-14-regular text-text-base">
            {language.t("provider.custom.description.prefix")}
            <Link href="https://vectordev.ai/docs/models" tabIndex={-1}>
              {language.t("provider.custom.description.link")}
            </Link>
            {language.t("provider.custom.description.suffix")}
          </p>

          <div class="flex flex-col gap-2">
            <label class="text-12-medium text-text-weak">Server</label>
            <div class="flex flex-wrap gap-2">
              <For each={PRESETS}>
                {(preset) => (
                  <Button
                    type="button"
                    size="small"
                    variant={form.kind === preset.kind ? "primary" : "ghost"}
                    aria-pressed={form.kind === preset.kind}
                    onClick={() => pickPreset(preset)}
                  >
                    {preset.label}
                  </Button>
                )}
              </For>
            </div>
            <Show when={props.detect}>
              <Button
                type="button"
                size="small"
                variant="secondary"
                class="self-start"
                disabled={search.status === "looking"}
                onClick={find}
              >
                {search.status === "looking" ? "Looking on this computer…" : "Find servers on this computer"}
              </Button>
            </Show>
            <Show when={search.servers.length > 1}>
              <div class="flex flex-col gap-1">
                <For each={search.servers}>
                  {(server) => (
                    <Button
                      type="button"
                      size="small"
                      variant={form.server?.origin === server.origin ? "primary" : "ghost"}
                      class="self-start"
                      onClick={() => chooseServer(server)}
                    >
                      {`${identity(server)} · ${server.origin}`}
                    </Button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={search.message}>
              <p class="text-12-regular text-text-weak" role="status">
                {search.message}
              </p>
            </Show>
          </div>

          <div class="flex flex-col gap-4">
            <TextField
              autofocus
              label={language.t("provider.custom.field.providerID.label")}
              placeholder={language.t("provider.custom.field.providerID.placeholder")}
              description={language.t("provider.custom.field.providerID.description")}
              value={form.providerID}
              onChange={(v) => setField("providerID", v)}
              validationState={form.err.providerID ? "invalid" : undefined}
              error={form.err.providerID}
            />
            <TextField
              label={language.t("provider.custom.field.name.label")}
              placeholder={language.t("provider.custom.field.name.placeholder")}
              value={form.name}
              onChange={(v) => setField("name", v)}
              validationState={form.err.name ? "invalid" : undefined}
              error={form.err.name}
            />
            <div class="flex flex-col gap-1.5">
              <div class="flex gap-2 items-end">
                <div class="flex-1">
                  <TextField
                    label={language.t("provider.custom.field.baseURL.label")}
                    placeholder={language.t("provider.custom.field.baseURL.placeholder")}
                    value={form.baseURL}
                    onChange={(v) => setField("baseURL", v)}
                    validationState={form.err.baseURL ? "invalid" : undefined}
                    error={form.err.baseURL}
                  />
                </div>
                <Show when={props.identify}>
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    disabled={search.status === "looking" || !form.baseURL.trim()}
                    onClick={identifyTyped}
                  >
                    Identify
                  </Button>
                </Show>
              </div>
              <Show when={label().identity}>
                <p class="text-12-regular text-text-base">{label().identity}</p>
              </Show>
              <Show when={label().notEncrypted}>
                <p class="text-12-medium text-text-strong">{COPY.notEncrypted}</p>
              </Show>
              <Show when={label().sharedMachine}>
                <p class="text-12-regular text-text-weak">{COPY.sharedMachine}</p>
              </Show>
              <Show when={label().forwarding}>
                <p class="text-12-regular text-text-weak">{COPY.forwarding}</p>
              </Show>
              <Show when={label().changedAddress}>
                <p class="text-12-regular text-text-weak">{COPY.changedAddress}</p>
              </Show>
            </div>
            <TextField
              label={language.t("provider.custom.field.apiKey.label")}
              placeholder={language.t("provider.custom.field.apiKey.placeholder")}
              description={language.t("provider.custom.field.apiKey.description")}
              value={form.apiKey}
              onChange={(v) => setField("apiKey", v)}
            />
            <Show when={form.kind}>
              <TextField
                label="Requests at once"
                placeholder={COPY.concurrencyEmpty(label().hosted)}
                description="How many requests Vector sends this server at once. The user's turn goes first, then subagents, then titles and summaries."
                value={form.concurrency ?? ""}
                onChange={(v) => setField("concurrency", v)}
                validationState={form.err.concurrency ? "invalid" : undefined}
                error={form.err.concurrency}
              />
            </Show>
          </div>

          <div class="flex flex-col gap-3">
            <label class="text-12-medium text-text-weak">{language.t("provider.custom.models.label")}</label>
            <Show when={search.skipped > 0}>
              <p class="text-12-regular text-text-weak">{COPY.cloudModels(search.skipped)}</p>
            </Show>
            <For each={form.models}>
              {(m, i) => (
                <div class="flex flex-col gap-2" data-row={m.row}>
                  <div class="flex gap-2 items-start">
                    <div class="flex-1">
                      <TextField
                        label={language.t("provider.custom.models.id.label")}
                        hideLabel
                        placeholder={language.t("provider.custom.models.id.placeholder")}
                        value={m.id}
                        onChange={(v) => setModel(i(), "id", v)}
                        validationState={m.err.id ? "invalid" : undefined}
                        error={m.err.id}
                      />
                    </div>
                    <div class="flex-1">
                      <TextField
                        label={language.t("provider.custom.models.name.label")}
                        hideLabel
                        placeholder={language.t("provider.custom.models.name.placeholder")}
                        value={m.name}
                        onChange={(v) => setModel(i(), "name", v)}
                        validationState={m.err.name ? "invalid" : undefined}
                        error={m.err.name}
                      />
                    </div>
                    <IconButton
                      type="button"
                      icon="trash"
                      variant="ghost"
                      class="mt-1.5"
                      onClick={() => removeModel(i())}
                      disabled={form.models.length <= 1}
                      aria-label={language.t("provider.custom.models.remove")}
                    />
                  </div>
                  <div class="flex gap-2 items-start pl-1">
                    <div class="flex-1">
                      <TextField
                        label="Context (tokens)"
                        placeholder="Unknown"
                        value={m.context ?? ""}
                        onChange={(v) => setModel(i(), "context", v)}
                        validationState={m.err.context ? "invalid" : undefined}
                        error={m.err.context}
                      />
                    </div>
                    <div class="flex-1">
                      <TextField
                        label="Reply limit (tokens)"
                        placeholder="A quarter of the context"
                        value={m.output ?? ""}
                        onChange={(v) => setModel(i(), "output", v)}
                        validationState={m.err.output ? "invalid" : undefined}
                        error={m.err.output}
                      />
                    </div>
                  </div>
                  <div class="flex gap-4 items-center pl-1">
                    <Checkbox checked={m.tools !== false} onChange={(value) => setModelFlag(i(), "tools", value)}>
                      Calls tools
                    </Checkbox>
                    <Checkbox checked={m.vision === true} onChange={(value) => setModelFlag(i(), "vision", value)}>
                      Reads images
                    </Checkbox>
                  </div>
                  <Show when={label().hosted && m.id.trim() && !m.context?.trim()}>
                    <p class="text-12-regular text-text-weak pl-1">{COPY.unknownContext}</p>
                  </Show>
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addModel} class="self-start">
              {language.t("provider.custom.models.add")}
            </Button>
          </div>

          <div class="flex flex-col gap-3">
            <label class="text-12-medium text-text-weak">{language.t("provider.custom.headers.label")}</label>
            <For each={form.headers}>
              {(h, i) => (
                <div class="flex gap-2 items-start" data-row={h.row}>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.headers.key.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.headers.key.placeholder")}
                      value={h.key}
                      onChange={(v) => setHeader(i(), "key", v)}
                      validationState={h.err.key ? "invalid" : undefined}
                      error={h.err.key}
                    />
                  </div>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.headers.value.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.headers.value.placeholder")}
                      value={h.value}
                      onChange={(v) => setHeader(i(), "value", v)}
                      validationState={h.err.value ? "invalid" : undefined}
                      error={h.err.value}
                    />
                  </div>
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    class="mt-1.5"
                    onClick={() => removeHeader(i())}
                    disabled={form.headers.length <= 1}
                    aria-label={language.t("provider.custom.headers.remove")}
                  />
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addHeader} class="self-start">
              {language.t("provider.custom.headers.add")}
            </Button>
          </div>

          <Button
            class="w-auto self-start"
            type="submit"
            size="large"
            variant="primary"
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? language.t("common.saving") : language.t("common.submit")}
          </Button>
        </form>
      </div>
    </Dialog>
  )
}
