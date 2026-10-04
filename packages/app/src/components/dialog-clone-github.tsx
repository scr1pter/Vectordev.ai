import { Button } from "@vectordevai/ui/button"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { Dialog } from "@vectordevai/ui/dialog"
import { Progress } from "@vectordevai/ui/progress"
import { Spinner } from "@vectordevai/ui/spinner"
import { TextField } from "@vectordevai/ui/text-field"
import { Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"

import { useGlobal } from "@/context/global"
import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { showToast } from "@/utils/toast"
import { uuid } from "@/utils/uuid"
import { directoryPickerKind } from "./directory-picker-policy"
import {
  GithubDeviceSignIn,
  GithubRepoOptions,
  githubApi,
  messageOf,
  type GithubAuthStatus,
  type GithubCloneFailure,
  type GithubCloneParent,
  type GithubCloneParse,
  type GithubCloneProgress,
  type GithubCloneResult,
  type GithubRepo,
} from "./github-connect"

type Mode = "checking" | "form" | "sign-in" | "cloning"

// "Open from GitHub": clone a repository on this machine, then open it the way Open Project does (a new draft
// session in that folder).
export function useCloneFromGithub() {
  const platform = usePlatform()
  const dialog = useDialog()
  const global = useGlobal()
  const tabs = useTabs()

  return {
    // Cloning runs on this machine, so the native folder picker's rule applies: desktop with a local server. WSL, SSH
    // and remote servers could not open the folder.
    available: (conn?: ServerConnection.Any) =>
      Boolean(conn && githubApi()?.clone && directoryPickerKind(platform.platform, conn) === "native"),
    // By default the clone opens in a new draft session; a caller that already has a draft (the composer's project
    // picker) passes its own onOpened to select the folder there instead.
    open(conn: ServerConnection.Any, onOpened?: (directory: string) => void) {
      dialog.show(() => (
        <DialogCloneGithub
          onOpened={
            onOpened ??
            ((directory) => {
              const ctx = global.ensureServerCtx(conn)
              ctx.projects.open(directory)
              ctx.projects.touch(directory)
              tabs.newDraft({ server: ServerConnection.key(conn), directory })
            })
          }
        />
      ))
    },
  }
}

export function DialogCloneGithub(props: { onOpened: (directory: string) => void }) {
  const dialog = useDialog()
  const api = githubApi()

  const [store, setStore] = createStore({
    mode: "checking" as Mode,
    query: "",
    // The full name of the repository row the user clicked; otherwise the parsed input is the selection.
    clicked: undefined as string | undefined,
    folder: "",
    folderEdited: false,
    canceling: false,
    repoError: undefined as string | undefined,
    notice: undefined as string | undefined,
  })
  // Snapshots from the main process stay signals: a store would merge one union value into the next.
  const [auth, setAuth] = createSignal<GithubAuthStatus>()
  const [repos, setRepos] = createSignal<GithubRepo[]>()
  const [parsed, setParsed] = createSignal<GithubCloneParse>()
  const [parent, setParent] = createSignal<GithubCloneParent>()
  const [progress, setProgress] = createSignal<GithubCloneProgress>()
  const [failure, setFailure] = createSignal<GithubCloneFailure>()

  let runId: string | undefined
  let disposed = false
  let folderField: HTMLInputElement | undefined

  const unsubscribe = api?.clone?.subscribe((event) => {
    if (event.runId === runId) setProgress(event)
  })
  onCleanup(() => {
    disposed = true
    unsubscribe?.()
    // Closing the dialog mid-clone cancels it; main stops git and removes the partial folder.
    if (runId) void api?.clone?.cancel(runId).catch(() => {})
  })

  const signedIn = () => Boolean(auth()?.configured && auth()?.authenticated)
  const parsedRepo = () => {
    const result = parsed()
    return result?.ok ? result.repo : undefined
  }
  const parseError = () => {
    const result = parsed()
    return store.query.trim() && result && !result.ok ? result.error : undefined
  }
  const selected = createMemo(() => {
    const repo = store.clicked ? repos()?.find((item) => item.fullName === store.clicked) : undefined
    return repo ? { owner: repo.owner, name: repo.name } : parsedRepo()
  })
  const destination = () => {
    const base = parent()?.path
    if (!base) return undefined
    const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/"
    return `${base.replace(/[\\/]+$/, "")}${separator}${store.folder}`
  }
  const ready = () => Boolean(selected() && store.folder.trim() && parent() && api?.clone)
  // A pasted link filters the list by the repository it names, so the user's own copy shows up when they have one.
  const listQuery = () => {
    const repo = parsedRepo()
    return repo ? `${repo.owner}/${repo.name}` : store.query
  }
  const emptyText = () => {
    if (parseError()) return parseError()!
    if (parsedRepo()) return "None of your repositories match. Vector will clone the repository above."
    return store.query.trim()
      ? "No repositories match your search."
      : "No repositories on this account yet. Paste a GitHub link to clone one."
  }
  const phaseLabel = () => {
    const current = progress()
    if (!current || current.phase === "starting") return "Connecting to GitHub…"
    if (current.phase === "receiving") return `Downloading… ${current.percent}%`
    if (current.phase === "resolving") return `Unpacking… ${current.percent}%`
    return `Writing files… ${current.percent}%`
  }

  // The folder name follows the chosen repository until the user types their own.
  createEffect(
    on(selected, (repo) => {
      if (repo && !store.folderEdited) setStore("folder", repo.name)
    }),
  )

  async function initialize() {
    void loadParent()
    const status = await api?.auth?.status().catch(() => undefined)
    if (disposed) return
    setAuth(status)
    if (status?.configured && status.authenticated) void loadRepos()
    setStore("mode", "form")
  }

  async function loadParent() {
    const next = await api?.clone?.parent().catch((error: unknown) => {
      setFailure({ ok: false, kind: "disk", error: messageOf(error) })
      return undefined
    })
    if (next) setParent(next)
  }

  async function loadRepos() {
    setStore("repoError", undefined)
    setRepos(undefined)
    const list = await api?.repos?.list().catch((error: unknown) => {
      setStore("repoError", messageOf(error))
      return []
    })
    setRepos(list ?? [])
  }

  // A clone can find the sign-in expired (main then signs out), so the account row has to catch up.
  async function refreshAuth() {
    const status = await api?.auth?.status().catch(() => undefined)
    if (status && !disposed) setAuth(status)
  }

  async function updateQuery(text: string) {
    setStore({ query: text, clicked: undefined })
    setFailure(undefined)
    if (!text.trim()) {
      setParsed(undefined)
      return
    }
    const result = await api?.clone?.parse(text).catch(() => undefined)
    // Replies can arrive out of order while the user types; only the latest text counts.
    if (store.query === text) setParsed(result)
  }

  async function changeParent() {
    const next = await api?.clone?.pickParent().catch((error: unknown) => {
      showToast({ variant: "error", title: "Couldn't change the folder", description: messageOf(error) })
      return null
    })
    if (next) setParent(next)
  }

  function connected(login?: string) {
    setAuth({ configured: true, authenticated: true, login })
    showToast({
      variant: "success",
      title: login ? `Connected as ${login}` : "GitHub connected",
      description: "Pick a repository to clone.",
    })
    setFailure(undefined)
    setStore("mode", "form")
    void loadRepos()
  }

  async function clone(event?: SubmitEvent) {
    event?.preventDefault()
    const repo = selected()
    const current = parent()
    const bridge = api?.clone
    if (!repo || !current || !bridge || !store.folder.trim() || store.mode === "cloning") return
    const id = uuid()
    runId = id
    setFailure(undefined)
    setProgress(undefined)
    setStore({ notice: undefined, canceling: false, mode: "cloning" })
    const result = await bridge
      .start({ runId: id, repo: `${repo.owner}/${repo.name}`, folder: store.folder, parent: current.path })
      .catch((error: unknown): GithubCloneResult => ({ ok: false, kind: "failed", error: messageOf(error) }))
    runId = undefined
    if (disposed) return
    if (result.ok) {
      dialog.close()
      props.onOpened(result.directory)
      showToast({
        variant: "success",
        title: result.reused ? "Opened your existing clone" : `Cloned ${result.fullName}`,
        description: result.reused
          ? `${result.directory} already has ${result.fullName}.`
          : `Opened ${result.directory} in a new session.`,
      })
      return
    }
    setStore("mode", "form")
    if (result.kind === "canceled") {
      setStore("notice", result.error)
      return
    }
    setFailure(result)
    if (result.kind === "exists" && result.suggestedFolder) {
      setStore({ folder: result.suggestedFolder, folderEdited: true })
      queueMicrotask(() => folderField?.focus())
    }
    // The parent can change in another window; reload it so the next attempt uses the current one.
    if (result.kind === "invalid") void loadParent()
    if (result.kind === "auth") void refreshAuth()
  }

  function cancelClone() {
    if (!runId) return
    setStore("canceling", true)
    void api?.clone?.cancel(runId).catch(() => {})
  }

  onMount(() => void initialize())

  return (
    <Dialog
      title="Open from GitHub"
      description="Clone a GitHub repository to this computer and open it in Vector."
      class="w-full max-w-[560px] mx-auto [&_[data-slot=dialog-body]]:min-h-0 [&_[data-slot=dialog-body]]:overflow-y-auto [&_[data-slot=dialog-body]]:overscroll-contain"
    >
      <Switch>
        <Match when={store.mode === "checking"}>
          <div class="flex items-center justify-center gap-3 p-10">
            <Spinner class="size-4 text-text-weak" />
            <span class="text-13-regular text-text-weak">Checking GitHub…</span>
          </div>
        </Match>

        <Match when={store.mode === "sign-in"}>
          <GithubDeviceSignIn
            intro="Authorize Vector with your GitHub account to see your repositories and clone private ones."
            autoStart
            closeLabel="Back"
            onConnected={connected}
            onClose={() => setStore("mode", "form")}
          />
        </Match>

        <Match when={store.mode === "cloning"}>
          <div class="flex flex-col gap-4 p-6 pt-2">
            <div class="min-w-0 text-13-regular text-text-weak">
              Cloning{" "}
              <span class="text-13-medium text-text-strong">
                {selected() ? `${selected()!.owner}/${selected()!.name}` : ""}
              </span>{" "}
              into <span class="break-all text-text-strong">{destination()}</span>
            </div>
            <Progress value={progress()?.percent ?? 0} minValue={0} maxValue={100}>
              {phaseLabel()}
            </Progress>
            <Show when={progress()?.phase !== "starting" && progress()?.message}>
              <div class="truncate font-mono text-11-regular text-text-weak">{progress()?.message}</div>
            </Show>
            <div class="flex items-center justify-end">
              <Button type="button" onClick={cancelClone} disabled={store.canceling}>
                {store.canceling ? "Canceling…" : "Cancel clone"}
              </Button>
            </div>
          </div>
        </Match>

        <Match when={store.mode === "form"}>
          <form onSubmit={clone} class="flex flex-col gap-4 p-6 pt-2">
            <Show when={auth()?.configured}>
              <div class="flex items-center justify-between gap-3 rounded-lg border border-border-weak-base bg-surface-base px-4 py-2.5">
                <Show
                  when={signedIn()}
                  fallback={
                    <>
                      <span class="min-w-0 text-12-regular text-text-weak">
                        Connect GitHub to see your repositories and clone private ones.
                      </span>
                      <Button type="button" size="small" onClick={() => setStore("mode", "sign-in")}>
                        Connect GitHub
                      </Button>
                    </>
                  }
                >
                  <div class="flex min-w-0 items-center gap-2">
                    <Show when={auth()?.avatarUrl}>
                      <img src={auth()?.avatarUrl} alt="" class="size-5 shrink-0 rounded-full" />
                    </Show>
                    <span class="truncate text-13-medium text-text-strong">
                      Connected as {auth()?.login ?? "GitHub"}
                    </span>
                  </div>
                </Show>
              </div>
            </Show>

            <div role="radiogroup" aria-label="Repository" class="flex flex-col gap-2">
              <TextField
                autofocus
                label="Repository"
                value={store.query}
                onChange={(value) => void updateQuery(value)}
                placeholder={
                  signedIn()
                    ? "Search your repositories or paste a GitHub link"
                    : "owner/name or https://github.com/owner/name"
                }
              />
              <Show when={parsedRepo()}>
                {(repo) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!store.clicked}
                    onClick={() => setStore("clicked", undefined)}
                    class="flex w-full items-center gap-3 rounded-lg border border-border-weak-base px-4 py-2.5 text-left transition-colors hover:bg-surface-raised-base-hover"
                    classList={{ "bg-surface-raised-base": !store.clicked }}
                  >
                    <span class="grid size-3.5 shrink-0 place-items-center rounded-full border border-border-weak-base">
                      <Show when={!store.clicked}>
                        <span class="size-2 rounded-full bg-[rgb(139,92,246)]" />
                      </Show>
                    </span>
                    <span class="min-w-0 flex-1 truncate text-13-medium text-text-strong">
                      Clone {repo().owner}/{repo().name}
                    </span>
                  </button>
                )}
              </Show>
              <Show
                when={signedIn()}
                fallback={
                  <Show when={parseError()}>
                    <div class="text-12-regular text-text-weak">{parseError()}</div>
                  </Show>
                }
              >
                <GithubRepoOptions
                  repos={repos()}
                  error={store.repoError}
                  query={listQuery()}
                  selected={store.clicked}
                  emptyText={emptyText()}
                  onSelect={(repo) => {
                    setStore("clicked", repo.fullName)
                    setFailure(undefined)
                  }}
                  onRetry={() => void loadRepos()}
                />
              </Show>
            </div>

            <div class="flex flex-col gap-3 rounded-lg border border-border-weak-base px-4 py-3">
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-12-medium text-text-weak">Clone to</div>
                  <div class="truncate text-13-medium text-text-strong" title={destination()}>
                    {destination() ?? "Loading…"}
                  </div>
                </div>
                <Button type="button" size="small" onClick={() => void changeParent()} disabled={!parent()}>
                  Change…
                </Button>
              </div>
              <TextField
                ref={folderField}
                label="Folder name"
                value={store.folder}
                onChange={(value) => {
                  setStore({ folder: value, folderEdited: true })
                  setFailure(undefined)
                }}
              />
            </div>

            <Show when={failure()}>
              {(current) => (
                <div class="rounded-lg border border-[rgba(236,94,94,0.35)] bg-[rgba(236,94,94,0.08)] px-4 py-3">
                  <div class="text-13-medium text-text-strong">{current().error}</div>
                  <Show when={current().detail}>
                    <details class="mt-2">
                      <summary class="cursor-pointer text-12-medium text-text-weak">Git output</summary>
                      <pre class="mt-2 max-h-36 overflow-auto whitespace-pre-wrap text-11-regular text-text-weak">
                        {current().detail}
                      </pre>
                    </details>
                  </Show>
                  <Show when={current().kind === "auth" && auth()?.configured && !signedIn()}>
                    <div class="mt-3">
                      <Button type="button" size="small" onClick={() => setStore("mode", "sign-in")}>
                        Connect GitHub
                      </Button>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
            <Show when={store.notice}>
              <div class="text-12-regular text-text-weak">{store.notice}</div>
            </Show>

            <div class="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => dialog.close()}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!ready()}>
                Clone and open
              </Button>
            </div>
          </form>
        </Match>
      </Switch>
    </Dialog>
  )
}
