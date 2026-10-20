import type { MemoryModelOption, MemoryModelPayload, MemoryModelStatus, VectorClient } from "@vectordevai/sdk/v2/client"
import { For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import {
  MODEL_DONE,
  MODEL_DOWNLOADS_OFF,
  MODEL_FALLBACK_UNVERIFIED,
  POLL,
  checkLabel,
  embeddedLabel,
  megabytes,
  modelHeadline,
  modelLicense,
  modelOffer,
  modelPolling,
  refusal,
  runsLabel,
  shortSha,
  sourceLabel,
} from "./memory-documents-model"

// Settings > Memory > Search model: the local model documents are searched by meaning with. Nothing is downloaded
// until the user asks; each model is described first (size, license, source and the sha256 its graph must have), and
// once it is ready it runs on this computer with no network. Until then search uses keywords and code links.
export function SettingsMemorySearchModel(props: { client: () => VectorClient | undefined }) {
  const [version, setVersion] = createSignal(0)
  const [note, setNote] = createSignal<{ tone: "ok" | "error"; text: string }>()
  const refresh = () => setVersion((value) => value + 1)

  const [status, { mutate }] = createResource(
    () => {
      const client = props.client()
      return client ? { client, version: version() } : false
    },
    (input) =>
      input.client.memory.model
        .get()
        .then((result) => result.data)
        .catch(() => undefined),
  )

  // While it downloads, checks or embeds, ask again every two seconds.
  createEffect(() => {
    if (!modelPolling(status.latest)) return
    const timer = setTimeout(refresh, POLL)
    onCleanup(() => clearTimeout(timer))
  })

  const act = async (payload: MemoryModelPayload, done: string) => {
    const client = props.client()
    if (!client) return
    const result = await client.memory.model
      .update({ memoryModelPayload: payload })
      .catch((cause: unknown) => ({ error: cause, data: undefined }))
    if (result.error || !result.data) {
      setNote({ tone: "error", text: refusal(result.error).message ?? "Vector could not change the search model." })
      return
    }
    mutate(result.data)
    setNote({ tone: "ok", text: done })
    refresh()
  }

  const current = () => status.latest
  const ready = () => current()?.state === "ready"
  const busy = () => current()?.state === "downloading" || current()?.state === "verifying"

  return (
    <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-search-model">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">Search by meaning</h3>
          <p class="settings-v2-card-description" data-component="settings-memory-model-headline">
            <Show when={!status.loading || current()} fallback="Reading the search model…">
              {modelHeadline(current())}
            </Show>
          </p>
        </div>
      </div>
      <div class="settings-v2-card-body">
        <Show when={busy()}>
          <div
            class="settings-memory-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((current()?.progress ?? 0) * 100)}
          >
            <span style={{ width: `${Math.round((current()?.progress ?? 0) * 100)}%` }} />
          </div>
        </Show>
        <Show when={embeddedLabel(current())}>{(label) => <p class="settings-memory-notice">{label()}</p>}</Show>
        <Show when={checkLabel(current())}>{(label) => <p class="settings-memory-notice">{label()}</p>}</Show>
        <Show when={sourceLabel(current())}>{(label) => <p class="settings-memory-notice">{label()}</p>}</Show>
        <Show when={runsLabel(current())}>{(label) => <p class="settings-memory-warning">{label()}</p>}</Show>
        <Show when={current()?.downloads === false && !ready()}>
          <p class="settings-memory-warning">{MODEL_DOWNLOADS_OFF}</p>
        </Show>
        <Show when={note()}>
          {(item) => (
            <p class={item().tone === "error" ? "settings-memory-error" : "settings-memory-notice"} role="status">
              {item().text}
            </p>
          )}
        </Show>

        <div class="settings-memory-list settings-memory-list--top">
          <For each={current()?.options ?? []}>
            {(option) => (
              <ModelRow
                option={option}
                status={current()!}
                onDownload={() => void act({ action: "download", model: modelID(option) }, MODEL_DONE.download)}
                onFallback={() =>
                  void act({ action: "download", model: modelID(option), variant: "fp32" }, MODEL_DONE.fallback)
                }
              />
            )}
          </For>
        </div>

        <Show when={ready() || current()?.state === "failed"}>
          <div class="settings-memory-actions">
            <Show when={ready() && current()?.paused}>
              <ButtonV2
                size="small"
                variant="outline"
                onClick={() => void act({ action: "resume" }, MODEL_DONE.resume)}
              >
                Resume embedding
              </ButtonV2>
            </Show>
            <Show when={ready() && !current()?.paused}>
              <ButtonV2 size="small" variant="outline" onClick={() => void act({ action: "pause" }, MODEL_DONE.pause)}>
                Pause embedding
              </ButtonV2>
            </Show>
            <ButtonV2 size="small" variant="ghost" onClick={() => void act({ action: "remove" }, MODEL_DONE.remove)}>
              Remove model
            </ButtonV2>
          </div>
        </Show>
      </div>
    </div>
  )
}

// One model Vector can download: what it is, what it costs to fetch, who made it and under what license, where its
// files come from and the sha256 its graph must have, and the button that asks for it.
function ModelRow(props: {
  option: MemoryModelOption
  status: MemoryModelStatus
  onDownload: () => void
  onFallback: () => void
}) {
  const inUse = () => props.status.model === props.option.id && props.status.state !== "absent"
  const offered = () => props.status.state === "absent" || (props.status.state === "ready" && !inUse())
  return (
    <div class="settings-memory-row" data-component="settings-memory-model" data-model={props.option.id}>
      <div class="settings-memory-row-head">
        <span class="settings-memory-doc-title">
          {props.option.label}
          <Show when={props.option.preview}> · Preview</Show>
        </span>
        <span class="settings-memory-tag">
          {inUse()
            ? `In use${props.status.variant === "fp32" ? " (full precision, not yet verified)" : ""}`
            : megabytes(props.option.bytes)}
        </span>
      </div>
      <p class="settings-memory-hold">{props.option.description}</p>
      <Show when={props.option.preview}>{(preview) => <p class="settings-memory-warning">{preview()}</p>}</Show>
      <p class="settings-memory-meta">
        {modelLicense(props.option)} ·{" "}
        <a href={props.option.source} target="_blank" rel="noreferrer">
          source at revision {props.option.revision.slice(0, 8)}
        </a>{" "}
        · <span title={props.option.sha256}>sha256 {shortSha(props.option.sha256)}</span>
      </p>
      <Show when={offered() && props.status.downloads !== false}>
        <p class="settings-memory-notice">{modelOffer(props.option)}</p>
      </Show>
      <div class="settings-memory-actions">
        <Show when={offered() && props.status.downloads !== false}>
          <ButtonV2
            size="small"
            variant={props.option.preview ? "outline" : "neutral"}
            icon="download"
            onClick={() => props.onDownload()}
          >
            Download ({megabytes(props.option.bytes)})
          </ButtonV2>
        </Show>
        <Show when={inUse() && props.status.state === "failed" && props.status.fallback && props.option.fallback}>
          {(bytes) => (
            <ButtonV2 size="small" variant="outline" icon="download" onClick={() => props.onFallback()}>
              Download the full-precision model ({megabytes(Number(bytes()))}, not yet verified)
            </ButtonV2>
          )}
        </Show>
      </div>
      <Show
        when={
          inUse() &&
          ((props.status.state === "failed" && props.status.fallback && props.option.fallback) ||
            props.status.variant === "fp32")
        }
      >
        <p class="settings-memory-warning">{MODEL_FALLBACK_UNVERIFIED}</p>
      </Show>
    </div>
  )
}

function modelID(option: MemoryModelOption): MemoryModelPayload["model"] {
  return option.id === "granite-small-r2-q8" ? "granite-small-r2-q8" : "arctic-embed-xs-q8"
}
