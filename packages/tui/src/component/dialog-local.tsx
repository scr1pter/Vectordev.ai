import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import type { LocalCheckResult, LocalServer, LocalUpdate, LocalWeb } from "@vectordevai/sdk/v2"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { refusal, useVectorLocal } from "../context/vector-local"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useToast } from "../ui/toast"

// /local: Vector Local in the terminal UI, for the server's owner. The switch, Web access, model servers on this
// computer, the services allowed, a held change, the check and what Vector sent. What would loosen Vector Local is
// confirmed in a dialog that lists what it loosens, and only then sent with `confirm`.

export const WEB_OPTIONS: readonly {
  readonly value: LocalWeb
  readonly title: string
  readonly description: string
}[] = [
  { value: "ask", title: "Ask", description: "Research and the browser can read the sites you approve." },
  { value: "network", title: "Your network only", description: "Only your network and sites your company lists." },
  {
    value: "none",
    title: "None",
    description: "Vector makes no internet requests. Deep research uses your brain and files.",
  },
]

const LOOSEN = "This change would loosen Vector Local. Apply it?"

/** Sends a change, asking first when it would loosen Vector Local. Resolves whether it applied; a refusal is a toast. */
export async function changeLocal(
  dialog: DialogContext,
  local: ReturnType<typeof useVectorLocal>,
  toast: ReturnType<typeof useToast>,
  change: LocalUpdate,
) {
  const first = await local.update(change)
  if (first.type === "applied") return true
  if (first.type === "refused") {
    toast.show({ variant: "error", message: first.message })
    return false
  }
  const yes = await DialogConfirm.show(
    dialog,
    "Loosen Vector Local?",
    `${LOOSEN} It ${first.changes.join(", ")}.`,
    "Keep",
  )
  if (yes !== true) return false
  const second = await local.update({ ...change, confirm: true })
  if (second.type === "applied") return true
  toast.show({ variant: "error", message: second.type === "refused" ? second.message : LOOSEN })
  return false
}

export function DialogLocal() {
  const local = useVectorLocal()
  const dialog = useDialog()
  const toast = useToast()
  onMount(() => void local.refresh())

  const options = createMemo(() => {
    const status = local.status()
    if (!status) return []
    const policy = status.policy
    const web = WEB_OPTIONS.find((item) => item.value === policy.web)
    return [
      {
        value: "switch",
        title: policy.enabled ? "Turn Vector Local off" : "Turn Vector Local on",
        description: policy.lock
          ? "Set by your company. Ask your administrator to change it."
          : "Run Vector's AI features on model servers you or your company host.",
        disabled: policy.lock,
        category: "Vector Local",
      },
      {
        value: "web",
        title: `Web access: ${web?.title ?? policy.web}`,
        description: web?.description,
        category: "Vector Local",
      },
      {
        value: "servers",
        title: "Models on this computer",
        description:
          policy.endpoints.length === 0
            ? "No model servers on your list yet"
            : `On your list: ${policy.endpoints.map((item) => item.origin).join(", ")}`,
        category: "Model servers",
      },
      {
        value: "allowed",
        title: "Allowed services",
        description: allowedLine(policy.allow),
        category: "Vector Local",
      },
      ...(status.held
        ? [
            {
              value: "held",
              title: "Apply the change waiting for you",
              description: `A change to your config would loosen Vector Local: it ${status.held.changes.join(", ")}.`,
              category: "Vector Local",
            },
          ]
        : []),
      { value: "check", title: "Run a check", description: "One row per layer", category: "Check" },
      {
        value: "sent",
        title: "What Vector sent",
        description: "This server's network log, origins only",
        category: "Check",
      },
    ]
  })

  return (
    <DialogSelect
      title="Vector Local"
      options={options()}
      emptyView={
        <text>{local.denied() ? "Only the server's owner can see Vector Local." : "Reading Vector Local…"}</text>
      }
      onSelect={async (option) => {
        const status = local.status()
        if (!status) return
        // After a change, or a confirmation the owner declined, the list shows Vector Local as it is now.
        if (option.value === "switch") {
          await changeLocal(dialog, local, toast, { enabled: !status.policy.enabled })
          dialog.replace(() => <DialogLocal />)
          return
        }
        if (option.value === "web") return dialog.replace(() => <DialogLocalWeb />)
        if (option.value === "servers") return dialog.replace(() => <DialogLocalServers />)
        if (option.value === "allowed") return dialog.replace(() => <DialogLocalAllowed />)
        if (option.value === "check") return dialog.replace(() => <DialogLocalCheck />)
        if (option.value === "sent") return dialog.replace(() => <DialogLocalSent />)
        if (option.value === "held" && status.held) {
          await changeLocal(dialog, local, toast, { held: [...status.held.changes] })
          dialog.replace(() => <DialogLocal />)
        }
      }}
    />
  )
}

export function DialogLocalWeb() {
  const local = useVectorLocal()
  const dialog = useDialog()
  const toast = useToast()
  return (
    <DialogSelect
      title="Web access with Vector Local on"
      current={local.status()?.policy.web}
      options={WEB_OPTIONS.map((item) => ({ value: item.value, title: item.title, description: item.description }))}
      onSelect={async (option) => {
        await changeLocal(dialog, local, toast, { web: option.value })
        dialog.replace(() => <DialogLocal />)
      }}
    />
  )
}

/** The services allowed with Vector Local on, in one line: each with the reason given for it. */
export function allowedLine(allow: readonly { readonly source: string; readonly reason: string }[]) {
  if (allow.length === 0) return "None: Vector's own services stay blocked"
  return allow.map((item) => `${item.source} (${item.reason})`).join(", ")
}

/** The services allowed with Vector Local on, each with its reason; picking one takes the allowance back. */
export function DialogLocalAllowed() {
  const local = useVectorLocal()
  const dialog = useDialog()
  const toast = useToast()
  return (
    <DialogSelect
      title="Allowed services (Vector Local)"
      options={(local.status()?.policy.allow ?? []).map((item) => ({
        value: item.source,
        title: `Stop allowing ${item.source}`,
        description: `${item.reason}${item.hosts?.length ? ` · ${item.hosts.join(", ")}` : ""} · added by ${item.added_by === "cli" ? "a terminal" : "the app"}`,
      }))}
      emptyView={<text>No services are allowed, so Vector's own services stay blocked with Vector Local on.</text>}
      onSelect={async (option) => {
        await changeLocal(dialog, local, toast, { allow: { remove: [option.value] } })
        dialog.replace(() => <DialogLocal />)
      }}
    />
  )
}

/** Find servers on this computer and add one: it goes on the list with its identity, and its models become a provider. */
export function DialogLocalServers() {
  const sdk = useSDK()
  const sync = useSync()
  const local = useVectorLocal()
  const dialog = useDialog()
  const toast = useToast()
  const [servers, setServers] = createSignal<readonly LocalServer[] | undefined>()
  onMount(async () => {
    const found = await sdk.client.local.detect().catch(() => undefined)
    setServers(found?.data ?? [])
  })

  const add = async (server: LocalServer, confirmed = false): Promise<void> => {
    const result = await sdk.client.local.servers.add({ url: server.origin, confirm: confirmed })
    if (result.data) {
      const added = result.data
      await local.refresh()
      await sync.bootstrap()
      toast.show({
        variant: added.identity?.length ? "warning" : "success",
        message: [
          ...(added.identity?.length ? [identityLine(server.origin, added.identity)] : []),
          `Added ${server.name} at ${server.origin} as ${added.provider}, with ${added.models.length} model${added.models.length === 1 ? "" : "s"}.`,
        ].join(" "),
      })
      dialog.clear()
      return
    }
    const error = result.error
    if (!confirmed && error && "name" in error && error.name === "LocalConfirmError") {
      const yes = await DialogConfirm.show(
        dialog,
        error.data.identity?.length ? "Accept a different server?" : "Loosen Vector Local?",
        [
          ...(error.data.identity?.length ? [identityLine(server.origin, error.data.identity)] : []),
          `${LOOSEN} It ${error.data.changes.join(", ")}.`,
        ].join(" "),
        "Keep",
      )
      if (yes === true) return add(server, true)
      return
    }
    toast.show({ variant: "error", message: refusal(error) })
  }

  return (
    <DialogSelect
      title="Models on this computer (Vector Local)"
      options={(servers() ?? []).map((server) => ({
        value: server.origin,
        title: [server.name, server.version].filter(Boolean).join(" "),
        description: `${server.origin} · ${server.models.filter((model) => !model.cloud).length} models`,
      }))}
      emptyView={
        <text>
          {servers() === undefined
            ? "Looking on this computer…"
            : "No model server answered on this computer. Start Ollama, LM Studio, vLLM, llama.cpp or SGLang, or add one elsewhere with vector local setup <address>."}
        </text>
      }
      onSelect={(option) => {
        const server = servers()?.find((item) => item.origin === option.value)
        if (server) void add(server)
      }}
    />
  )
}

/** The warning for a server on the list that answers as a different one, with what changed since it was added. */
export function identityLine(origin: string, changed: readonly string[]) {
  return `${new URL(origin).host} now answers as a different server (${changed.join(", ")} changed since it was added). Check it before sending prompts.`
}

export function DialogLocalCheck() {
  const sdk = useSDK()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [report, setReport] = createSignal<LocalCheckResult | undefined>()
  onMount(async () => {
    const result = await sdk.client.local.check().catch(() => undefined)
    setReport(result?.data)
  })
  const mark = (status: string) =>
    status === "pass"
      ? { text: "✓", fg: theme.success }
      : status === "warn"
        ? { text: "!", fg: theme.warning }
        : { text: "✗", fg: theme.error }
  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Vector Local check
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={report()} fallback={<text fg={theme.textMuted}>Checking…</text>}>
        {(current) => (
          <box>
            <For each={current().rows}>
              {(row) => (
                <box>
                  <text fg={theme.text} wrapMode="word">
                    <span style={{ fg: mark(row.status).fg }}>{mark(row.status).text}</span> {row.title}
                  </text>
                  <Show when={row.detail}>
                    <text fg={theme.textMuted} wrapMode="word">
                      {"  "}
                      {row.detail}
                    </text>
                  </Show>
                </box>
              )}
            </For>
          </box>
        )}
      </Show>
    </box>
  )
}

export function DialogLocalSent() {
  const sdk = useSDK()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [lines, setLines] = createSignal<readonly string[] | undefined>()
  onMount(async () => {
    const summary = (await sdk.client.local.egress.summary().catch(() => undefined))?.data
    if (!summary) return setLines(["Nothing to show."])
    setLines(summaryLines(summary))
  })
  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          What Vector sent
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <For each={lines() ?? ["Reading the network log…"]}>{(line) => <text fg={theme.text}>{line}</text>}</For>
      <text fg={theme.textMuted}>
        Kept on this computer while Vector Local is on. vector local log lists each request.
      </text>
    </box>
  )
}

/** The popover's lines: model calls by origin, web pages and searches, memory carried, and blocked requests. */
export function summaryLines(summary: {
  readonly model_calls: Readonly<Record<string, number>>
  readonly pages: number
  readonly hosts: number
  readonly searches: number
  readonly carried: { readonly personal: number; readonly documents: number }
  readonly blocked: Readonly<Record<string, number>>
  readonly helper_requests: number
}) {
  const calls = Object.entries(summary.model_calls)
  const blocked = Object.values(summary.blocked).reduce((sum, count) => sum + count, 0)
  return [
    calls.length === 0
      ? "Model calls: none"
      : `Model calls: ${calls.map(([origin, count]) => `${count} to ${origin}`).join(", ")}`,
    `Web: ${summary.pages} page${summary.pages === 1 ? "" : "s"}, ${summary.hosts} other host${summary.hosts === 1 ? "" : "s"} they loaded, ${summary.searches} search${summary.searches === 1 ? "" : "es"}`,
    `Memory sent: ${summary.carried.personal} personal card${summary.carried.personal === 1 ? "" : "s"}, ${summary.carried.documents} document passage${summary.carried.documents === 1 ? "" : "s"}`,
    `Blocked: ${blocked}`,
    ...(summary.helper_requests > 0
      ? [`Including ${summary.helper_requests} helper request${summary.helper_requests === 1 ? "" : "s"}`]
      : []),
  ]
}
