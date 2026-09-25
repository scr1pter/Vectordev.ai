import { Index, Show, createEffect, createMemo, on, onCleanup, onMount } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createStore } from "solid-js/store"
import { Schema } from "effect"
import { PublicSession } from "@vectordevai/schema/public-session"
import { useSDK } from "../context/sdk"
import { useClipboard } from "../context/clipboard"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"
import { errorMessage } from "../util/error"

export function DialogShareSession(props: { sessionID: string; unshareOnly?: boolean }) {
  const client = useSDK().client
  const clipboard = useClipboard()
  const dialog = useDialog()
  const theme = useTheme().theme
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined
  const [state, setState] = createStore<{
    preview?: PublicSession.Archive
    previewHash?: string
    info?: PublicSession.Info
    busy: boolean
    loading: boolean
    updates: boolean
    remember: boolean
    acknowledged: boolean
    days: number
    active: number
    showPreview: boolean
    confirmUnshare: boolean
    status: string
  }>({
    busy: false,
    loading: true,
    updates: false,
    remember: false,
    acknowledged: false,
    days: 7,
    active: 0,
    showPreview: false,
    confirmUnshare: false,
    status: "",
  })
  let alive = true
  onCleanup(() => {
    alive = false
  })
  const refresh = () => {
    setState({ loading: true, acknowledged: false, previewHash: undefined, status: "" })
    void Promise.allSettled([
      client.session.sharePreview({ sessionID: props.sessionID }, { throwOnError: true }),
      client.session.get({ sessionID: props.sessionID }, { throwOnError: true }),
    ])
      .then(async ([preview, session]) => {
        if (!alive) return
        const info = session.status === "fulfilled" ? session.value.data?.share : undefined
        setState({ info: Schema.is(PublicSession.Info)(info) ? info : undefined, loading: false })
        if (preview.status === "fulfilled") {
          const archive = Schema.decodeUnknownSync(PublicSession.Archive)(preview.value.data)
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify(preview.value.data)),
          )
          if (!alive) return
          setState({
            preview: archive,
            previewHash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
          })
        }
        if (preview.status === "rejected") setState("status", errorMessage(preview.reason))
        if (session.status === "rejected") setState("status", errorMessage(session.reason))
      })
      .catch((error) => {
        if (alive) setState({ loading: false, status: errorMessage(error) })
      })
  }
  onMount(() => {
    dialog.setSize("large")
    refresh()
  })
  const publish = async () => {
    if (props.unshareOnly || state.busy || state.loading || !state.previewHash || !state.preview || !state.acknowledged)
      return
    setState({ busy: true, status: "Publishing…" })
    await client.session
      .share(
        {
          sessionID: props.sessionID,
          publicSessionPublish: {
            consent: { version: 1, public: true, updates: state.updates },
            expiresAt: Date.now() + state.days * 86_400_000,
            remember: state.updates && state.remember,
            previewHash: state.previewHash,
          },
        },
        { throwOnError: true },
      )
      .then((result) => {
        if (alive)
          setState({
            info: Schema.decodeUnknownSync(PublicSession.Info)(result.data),
            status: "Public copy created.",
            active: 0,
            acknowledged: false,
          })
      })
      .catch((error) => {
        if (alive) setState("status", errorMessage(error))
      })
    if (alive) setState("busy", false)
  }
  const unshare = async () => {
    if (state.busy || !state.confirmUnshare) return
    setState({ busy: true, status: "Removing public copy…" })
    await client.session
      .unshare({ sessionID: props.sessionID }, { throwOnError: true })
      .then(() => {
        if (alive)
          setState({
            info: undefined,
            status: "Public copy removed. Local session unchanged.",
            active: 0,
            acknowledged: false,
            confirmUnshare: false,
          })
      })
      .catch((error) => {
        if (alive) setState("status", `${errorMessage(error)} Public link retained for retry.`)
      })
    if (alive) setState("busy", false)
  }
  const preview = createMemo(
    () =>
      state.preview?.messages
        .map(
          (message) =>
            `${message.role.toUpperCase()}\n${message.parts
              .map((part) => {
                if (part.type === "attachment") return `Attachment: ${part.name} (${part.mediaType}) — description only`
                if (part.type === "tool")
                  return `${part.name} (${part.status})\nInput:\n${part.input}\nOutput:\n${part.output}`
                return `${part.type === "reasoning" ? "Reasoning:\n" : ""}${part.text}`
              })
              .join("\n\n")}`,
        )
        .join("\n\n———\n\n") ?? "",
  )
  const options = createMemo(() => [
    {
      label: `${state.showPreview ? "Hide" : "Review"} included transcript (${state.preview?.messages.length ?? 0} messages)`,
      run: () => setState("showPreview", !state.showPreview),
      disabled: !state.preview,
    },
    { label: "Refresh included transcript", run: refresh, disabled: state.loading },
    ...(state.info
      ? [
          {
            label: "Copy public link",
            run: () =>
              void clipboard.write?.(state.info!.url).then(
                () => {
                  if (alive) setState("status", "Public link copied.")
                },
                () => {
                  if (alive) setState("status", "Could not copy. Select the public link above.")
                },
              ),
            disabled: false,
          },
          {
            label: `[${state.confirmUnshare ? "x" : " "}] Remove this public copy`,
            run: () => setState("confirmUnshare", !state.confirmUnshare),
            disabled: false,
          },
          { label: "Unshare", run: () => void unshare(), disabled: !state.confirmUnshare },
        ]
      : props.unshareOnly
        ? []
        : [
            {
              label: `Expires after ${state.days} days (change)`,
              run: () => setState("days", state.days === 1 ? 7 : state.days === 7 ? 30 : 1),
              disabled: false,
            },
            {
              label: `[${state.updates ? "x" : " "}] Include future conversation updates until expiry`,
              run: () => setState({ updates: !state.updates, remember: false }),
              disabled: false,
            },
            {
              label: `[${state.remember ? "x" : " "}] Also consent to automatic sharing of future sessions on this account${state.updates ? "" : " (requires future updates)"}`,
              run: () => setState("remember", !state.remember),
              disabled: !state.updates,
            },
            {
              label: `[${state.acknowledged ? "x" : " "}] I reviewed the content and want to make it public`,
              run: () => setState("acknowledged", !state.acknowledged),
              disabled: !state.previewHash || state.loading,
            },
            {
              label: "Publish public copy",
              run: () => void publish(),
              disabled: !state.previewHash || state.loading || !state.acknowledged,
            },
          ]),
    { label: state.info ? "Done" : "Cancel", run: () => dialog.clear(), disabled: false },
  ])
  const activate = (index: number) => {
    if (state.busy || options()[index]?.disabled) return
    options()[index]?.run()
  }
  const revealActive = () => queueMicrotask(() => {
    if (alive) scroll?.scrollChildIntoView(`share-option-${state.active}`)
  })
  createEffect(
    on(
      () => state.active,
      revealActive,
      { defer: true },
    ),
  )
  useBindings(() => ({
    bindings: [
      {
        key: "tab",
        desc: "Next sharing option",
        group: "Dialog",
        cmd: () => setState("active", (state.active + 1) % options().length),
      },
      {
        key: "down",
        desc: "Next sharing option",
        group: "Dialog",
        cmd: () => setState("active", (state.active + 1) % options().length),
      },
      {
        key: "up",
        desc: "Previous sharing option",
        group: "Dialog",
        cmd: () => setState("active", (state.active + options().length - 1) % options().length),
      },
      { key: "return", desc: "Select sharing option", group: "Dialog", cmd: () => activate(state.active) },
    ],
  }))
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text}>{props.unshareOnly ? "Unshare session" : "Share session publicly"}</text>
      <scrollbox
        ref={(value) => {
          scroll = value
        }}
        height={Math.max(6, Math.min(32, Math.floor(dimensions().height * 0.75) - 6))}
      >
        <box gap={1} onSizeChange={revealActive}>
          <text fg={theme.textMuted}>
            Anyone with the link can read and save conversation text, reasoning, code, and tool input/output. These may
            contain secrets. Attachments are descriptions only; no files are uploaded or fetched.
          </text>
          <text fg={theme.textMuted}>
            Requires your Vector account: run vector login on the connected server. Unsharing cannot erase copies saved
            by other people.
          </text>
          <Show when={state.remember && !state.info}>
            <text fg={theme.warning}>
              Account-wide consent applies to future sessions when automatic sharing is enabled, including sensitive
              content. Existing sessions are not published.
            </text>
          </Show>
          <Show when={state.loading}>
            <text fg={theme.textMuted}>Preparing full visible transcript…</text>
          </Show>
          <Show when={props.unshareOnly && !state.loading && !state.info && !state.status}>
            <text fg={theme.textMuted}>
              This session has no current Vector-managed public copy. Historical links are handled separately.
            </text>
          </Show>
          <Show when={state.info} keyed>
            {(info) => (
              <box>
                <text fg={theme.primary}>{info.url}</text>
                <text fg={theme.textMuted}>
                  Expires {new Date(info.expiresAt).toLocaleString()}.{" "}
                  {info.updates ? "Future updates are public." : "One-time snapshot."}
                </text>
              </box>
            )}
          </Show>
          <Show when={state.showPreview}>
            <scrollbox height={8}>
              <text fg={theme.text}>{preview()}</text>
            </scrollbox>
          </Show>
          <Index each={options()}>
            {(option, index) => (
              <box
                id={`share-option-${index}`}
                backgroundColor={state.active === index ? theme.backgroundElement : undefined}
                onMouseUp={() => {
                  setState("active", index)
                  activate(index)
                }}
              >
                <text
                  fg={
                    option().disabled || state.busy
                      ? theme.textMuted
                      : state.active === index
                        ? theme.primary
                        : theme.text
                  }
                >
                  {state.active === index ? "> " : "  "}
                  {option().label}
                </text>
              </box>
            )}
          </Index>
        </box>
      </scrollbox>
      <Show when={state.status}>
        <text fg={theme.textMuted}>{state.status}</text>
      </Show>
      <text fg={theme.textMuted}>Tab / ↑↓ select · Return activate · Esc close</text>
    </box>
  )
}
