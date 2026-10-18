import type { VectorClient } from "@vectordevai/sdk/v2/client"
import { getFilename } from "@vectordevai/core/util/path"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { DialogBody, DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@vectordevai/ui/v2/dialog-v2"
import { MenuV2 } from "@vectordevai/ui/v2/menu-v2"
import { createEffect, createMemo, createResource, createSignal, onCleanup, Show, untrack } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useProjectTrust } from "@/context/project-trust"
import {
  projectTrustHostDecides,
  projectTrustParent,
  projectTrustPrompt,
  projectTrustRecord,
  projectTrustStatus,
  type ProjectTrustPrompt,
} from "@/context/project-trust-policy"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import type { ServerConnection } from "@/context/server"
import { showToast } from "@/utils/toast"
import type { ServerScope } from "@/utils/server-scope"

/**
 * A project's own vector.json and .vector settings (agents, commands, plugins, MCP servers) can run code, so the
 * engine ignores them until the project is trusted. The first time such a project opens this asks once, and the
 * answer is remembered for that project: "Not now" never asks again, and a trusted project asks again only when the
 * engine stops trusting it because its settings changed. A project with no settings of its own never asks.
 */
export function ProjectTrustPrompt() {
  const sdk = useSDK()
  const serverSync = useServerSync()
  const trust = useProjectTrust()
  const dialog = useDialog()
  const language = useLanguage()
  const ask = useProjectTrustDialog()
  const [status] = createResource(
    () => ({ directory: sdk(), version: trust.version() }),
    (input) =>
      input.directory.client.config.trust
        .get()
        .then((result) => projectTrustStatus(result.data))
        .catch(() => undefined),
  )

  createEffect(() => {
    // While a refresh runs the resource still holds the status from before an approval; deciding on it would ask
    // about a project that was just trusted.
    if (status.state !== "ready" || !trust.ready()) return
    const current = status()
    if (!current) return
    const directory = sdk()
    const record = projectTrustRecord(current, trust.answer(directory.scope, current.workspace))
    if (record) trust.remember(directory.scope, current.workspace, record)
    // An invited guest's approval is refused, so the guest is told who decides instead of being asked.
    if (projectTrustHostDecides(current) && trust.tell(directory.scope, current.workspace))
      untrack(() =>
        showToast({
          title: language.t("project.trust.host.title"),
          description: language.t("project.trust.host.description", {
            name: getFilename(current.workspace) || current.workspace,
          }),
        }),
      )
    const prompt = projectTrustPrompt(current, record)
    // Another dialog keeps the screen; this one waits until it closes.
    if (!prompt || dialog.active) return
    untrack(() => {
      const parent = projectTrustParent(serverSync().data.project, current.workspace, directory.directory)
      ask({
        client: directory.client,
        scope: directory.scope,
        workspace: current.workspace,
        repository: parent && (parent.name || getFilename(parent.worktree) || parent.worktree),
        prompt,
        rememberDismissal: true,
      })
    })
  })

  return null
}

/**
 * "Trust this project…" in a project's menu, shown only while the engine ignores that project's own settings and this
 * client may approve (never for an invited guest). The status is read when the menu opens, so a closed menu costs
 * nothing.
 */
export function ProjectTrustMenuItem(props: { server: ServerConnection.Any; directory: string; open: boolean }) {
  const global = useGlobal()
  const trust = useProjectTrust()
  const language = useLanguage()
  const ask = useProjectTrustDialog()
  const target = createMemo(() => {
    const sdk = global.ensureServerCtx(props.server).sdk
    return { client: sdk.createClient({ directory: props.directory }), scope: sdk.scope }
  })
  const [status] = createResource(
    () => props.open && { ...target(), version: trust.version() },
    (input) =>
      input.client.config.trust
        .get()
        .then((result) => projectTrustStatus(result.data))
        .catch(() => undefined),
  )

  return (
    <Show when={projectTrustPrompt(status(), undefined) ? status() : undefined}>
      {(current) => (
        <MenuV2.Item
          onSelect={() =>
            ask({
              ...target(),
              workspace: current().workspace,
              // Opened by hand, so it asks the first-time question unless the project was trusted before.
              prompt: trust.answer(target().scope, current().workspace) === "trusted" ? "changed" : "ask",
            })
          }
        >
          {language.t("project.trust.menu")}
        </MenuV2.Item>
      )}
    </Show>
  )
}

/**
 * Opens the trust dialog for one repository, or for an agent or parallel workspace when `repository` names the
 * repository it belongs to. When `rememberDismissal` is set, closing it without trusting (Not now,
 * Escape or a click outside) is remembered so the repository never asks again; a dialog the user opened from a menu
 * leaves the answer as it was. Another dialog that replaces this one (release notes after an update, a spend stop)
 * is not an answer: nothing is remembered and the claim is released, so the question comes back once it closes.
 */
export function useProjectTrustDialog() {
  const dialog = useDialog()
  const trust = useProjectTrust()
  const language = useLanguage()

  return (input: {
    client: VectorClient
    scope: ServerScope
    workspace: string
    /** The repository this workspace folder belongs to, when it is not that repository's own folder. */
    repository?: string
    prompt: ProjectTrustPrompt
    rememberDismissal?: boolean
  }) => {
    if (!trust.claim(input.scope, input.workspace)) return
    const state = { trusted: false, released: false }
    // Runs on close and again when the dialog is disposed; only the first may release, or a later claim on the same
    // repository would be dropped.
    const release = () => {
      if (state.released) return
      state.released = true
      trust.release(input.scope, input.workspace)
    }
    const approve = async () => {
      const status = await trust.approve(input.client, input.scope)
      if (status) {
        state.trusted = true
        return true
      }
      showToast({
        variant: "error",
        title: language.t("project.trust.approve.failed"),
        description: language.t("project.trust.approve.failed.description"),
      })
      return false
    }
    void dialog.show(
      () => (
        <DialogProjectTrust
          name={input.repository ?? (getFilename(input.workspace) || input.workspace)}
          folder={input.repository === undefined ? undefined : input.workspace}
          changed={input.prompt === "changed"}
          onTrust={approve}
          onDispose={release}
        />
      ),
      () => {
        if (input.rememberDismissal && !state.trusted) trust.remember(input.scope, input.workspace, "dismissed")
        release()
      },
    )
  }
}

// The question's title and description: for a repository or for a workspace folder of one, asked the first time or
// after its settings changed.
const DIALOG_COPY = {
  repository: {
    ask: { title: "project.trust.dialog.title", description: "project.trust.dialog.description" },
    changed: { title: "project.trust.dialog.changed.title", description: "project.trust.dialog.changed.description" },
  },
  workspace: {
    ask: { title: "project.trust.dialog.workspace.title", description: "project.trust.dialog.workspace.description" },
    changed: {
      title: "project.trust.dialog.workspace.changed.title",
      description: "project.trust.dialog.workspace.changed.description",
    },
  },
} as const

function DialogProjectTrust(props: {
  name: string
  /** Set for an agent or parallel workspace, which is trusted apart from the repository `name` it belongs to. */
  folder?: string
  changed: boolean
  onTrust: () => Promise<boolean>
  onDispose: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [pending, setPending] = createSignal(false)
  const copy = () => DIALOG_COPY[props.folder ? "workspace" : "repository"][props.changed ? "changed" : "ask"]
  // Escape can close the dialog while the approval is still saving; closing again then would close whatever is on top.
  const state = { open: true }
  onCleanup(() => {
    state.open = false
    // dialog.show() disposes a dialog it replaces without calling its onClose.
    props.onDispose()
  })

  const trust = () => {
    if (pending()) return
    setPending(true)
    void props.onTrust().then((trusted) => {
      setPending(false)
      if (trusted && state.open) dialog.close()
    })
  }

  return (
    <DialogV2 fit class="vector-project-trust-dialog">
      <DialogHeader hideClose>
        <span class="vector-project-trust-dialog__mark" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <path
              d="M8 1.9 3.1 3.7v3.9c0 3 2.05 5.45 4.9 6.5 2.85-1.05 4.9-3.5 4.9-6.5V3.7L8 1.9Zm-2.1 6.2 1.45 1.45L10.2 6.7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <DialogTitleGroup
          title={language.t(copy().title)}
          description={language.t(copy().description, { name: props.name })}
        />
      </DialogHeader>
      <DialogBody class="vector-project-trust-dialog__body">
        <Show when={props.folder}>{(folder) => <p class="vector-project-trust-dialog__folder">{folder()}</p>}</Show>
        <p>{language.t(props.folder ? "project.trust.dialog.workspace.later" : "project.trust.dialog.later")}</p>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
          {language.t("project.trust.dialog.notNow")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={pending()} onClick={trust}>
          {language.t(props.folder ? "project.trust.dialog.workspace.trust" : "project.trust.dialog.trust")}
        </ButtonV2>
      </DialogFooter>
    </DialogV2>
  )
}
