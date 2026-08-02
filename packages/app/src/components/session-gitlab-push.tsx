import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount, type ComponentProps } from "solid-js"

import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"

type GitlabPublishResult = {
  ok: boolean
  url?: string
  error?: string
  log: string
}

type GitlabAuthStatus = {
  configured: boolean
  authenticated: boolean
  login?: string
  avatarUrl?: string
}

type GitlabDeviceCode = {
  userCode: string
  verificationUri: string
  expiresIn: number
}

type GitlabRepo = {
  id: number
  name: string
  pathWithNamespace: string
  private: boolean
  lastActivityAt?: string
  defaultBranch?: string
  webUrl: string
  httpUrl: string
}

type GitlabApi = {
  auth?: {
    status(): Promise<GitlabAuthStatus>
    start(): Promise<GitlabDeviceCode>
    openVerification(): Promise<void>
    complete(): Promise<{ ok: boolean; login?: string; error?: string }>
    cancel(): Promise<void>
    logout(): Promise<void>
  }
  repos?: {
    list(): Promise<GitlabRepo[]>
    create(input: { name: string; private: boolean; description?: string }): Promise<GitlabRepo>
  }
  pushOauth?(input: {
    projectPath: string
    repo?: { pathWithNamespace: string; httpUrl: string; webUrl?: string }
    createNew?: { name: string; private: boolean; description?: string }
    commitMessage?: string
  }): Promise<GitlabPublishResult>
}

type DialogMode = "checking" | "unavailable" | "signed-out" | "device-code" | "picker"

type RepoSelection = { kind: "repo"; repo: GitlabRepo } | { kind: "create" }

function gitlabApi() {
  return (globalThis.window as unknown as { api?: { gitlab?: GitlabApi } }).api?.gitlab
}

function messageOf(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function relativeTime(iso?: string) {
  if (!iso) return undefined
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return undefined
  const minutes = Math.round((Date.now() - then) / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

export function SessionGitlabPush(props: { placement?: ComponentProps<typeof TooltipV2>["placement"] }) {
  const dialog = useDialog()
  const sdk = useSDK()

  return (
    <TooltipV2 value="Commit and push this project to GitLab" placement={props.placement ?? "bottom"} shift={-8}>
      <IconButtonV2
        type="button"
        variant="ghost-muted"
        size="large"
        icon={<Icon name="gitlab" size="small" />}
        onClick={() => dialog.show(() => <DialogGitlabPush projectPath={sdk().directory} />)}
        aria-label="Push project to GitLab"
      />
    </TooltipV2>
  )
}

function ResultPanel(props: { result?: GitlabPublishResult }) {
  return (
    <Show when={props.result} keyed>
      {(current) => (
        <div
          class="rounded-lg border px-4 py-3"
          classList={{
            "border-[rgba(83,196,120,0.35)] bg-[rgba(83,196,120,0.08)]": current.ok,
            "border-[rgba(236,94,94,0.35)] bg-[rgba(236,94,94,0.08)]": !current.ok,
          }}
        >
          <div class="text-13-medium text-text-strong">
            {current.ok ? "Project is up to date" : current.error || "Push failed"}
          </div>
          <Show when={current.log}>
            <details class="mt-2">
              <summary class="cursor-pointer text-12-medium text-text-weak">Command log</summary>
              <pre class="mt-2 max-h-36 overflow-auto whitespace-pre-wrap text-11-regular text-text-weak">
                {current.log}
              </pre>
            </details>
          </Show>
        </div>
      )}
    </Show>
  )
}

export function DialogGitlabPush(props: { projectPath: string }) {
  const dialog = useDialog()
  const platform = usePlatform()
  const api = gitlabApi()
  const projectName = () => props.projectPath.split(/[\\/]/).filter(Boolean).at(-1) || "vector-app"

  const [mode, setMode] = createSignal<DialogMode>("checking")
  // Why the picker/sign-in isn't available (no desktop bridge vs no client ID).
  const [unavailableReason, setUnavailableReason] = createSignal<string>()

  const [name, setName] = createSignal(projectName())
  const [description, setDescription] = createSignal("")
  const [commitMessage, setCommitMessage] = createSignal("Update from Vector")
  const [isPrivate, setPrivate] = createSignal(true)
  const [result, setResult] = createSignal<GitlabPublishResult>()

  // OAuth flow state.
  const [authStatus, setAuthStatus] = createSignal<GitlabAuthStatus>()
  const [deviceCode, setDeviceCode] = createSignal<GitlabDeviceCode>()
  const [authError, setAuthError] = createSignal<string>()
  const [starting, setStarting] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  const [repos, setRepos] = createSignal<GitlabRepo[]>()
  const [repoError, setRepoError] = createSignal<string>()
  const [search, setSearch] = createSignal("")
  const [selection, setSelection] = createSignal<RepoSelection>()
  const [pushing, setPushing] = createSignal(false)

  let disposed = false
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    disposed = true
    if (copyTimer) clearTimeout(copyTimer)
    if (mode() === "device-code") void api?.auth?.cancel().catch(() => {})
  })

  const oauthReady = createMemo(() => {
    const current = selection()
    if (!current || pushing()) return false
    if (current.kind === "create") return Boolean(name().trim())
    return true
  })

  const filteredRepos = createMemo(() => {
    const query = search().trim().toLowerCase()
    const list = repos() ?? []
    if (!query) return list
    return list.filter((repo) => repo.pathWithNamespace.toLowerCase().includes(query))
  })

  const dialogDescription = createMemo(() => {
    switch (mode()) {
      case "signed-out":
      case "device-code":
        return "Connect your GitLab account to commit and push this project."
      case "picker":
        return "Commit the current project and push it to a project on your GitLab account."
      case "unavailable":
        return "GitLab publishing isn't available here."
      default:
        return "Checking your GitLab connection."
    }
  })

  async function initialize() {
    if (!api?.auth || !api.pushOauth) {
      setUnavailableReason("Open this project in the Vector desktop app to push to GitLab.")
      setMode("unavailable")
      return
    }
    try {
      const auth = await api.auth.status()
      if (!auth.configured) {
        setUnavailableReason(
          "GitLab sign-in isn't set up in this build of Vector yet. Add a GitLab Application ID to enable it.",
        )
        setMode("unavailable")
        return
      }
      setAuthStatus(auth)
      if (auth.authenticated) {
        setMode("picker")
        void loadRepos()
      } else {
        setMode("signed-out")
      }
    } catch (error) {
      setUnavailableReason(messageOf(error))
      setMode("unavailable")
    }
  }

  async function startAuth() {
    const auth = api?.auth
    if (!auth || starting()) return
    setStarting(true)
    setAuthError(undefined)
    try {
      setDeviceCode(await auth.start())
      setMode("device-code")
      void waitForAuthorization()
    } catch (error) {
      setAuthError(messageOf(error))
      showToast({ variant: "error", title: "Could not reach GitLab", description: messageOf(error) })
    }
    setStarting(false)
  }

  async function waitForAuthorization() {
    const auth = api?.auth
    if (!auth) return
    try {
      const outcome = await auth.complete()
      if (disposed) return
      if (outcome.ok) {
        setAuthStatus({ configured: true, authenticated: true, login: outcome.login })
        showToast({
          variant: "success",
          title: outcome.login ? `Connected as ${outcome.login}` : "GitLab connected",
          description: "Pick a project to push this to.",
        })
        setMode("picker")
        void loadRepos()
      } else {
        setAuthError(outcome.error || "GitLab did not authorize this device.")
      }
    } catch (error) {
      if (!disposed) setAuthError(messageOf(error))
    }
  }

  async function openVerification() {
    try {
      await api?.auth?.openVerification()
    } catch (error) {
      showToast({ variant: "error", title: "Could not open GitLab", description: messageOf(error) })
    }
  }

  async function copyCode() {
    const code = deviceCode()?.userCode
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      showToast({ variant: "error", title: "Copy failed", description: messageOf(error) })
    }
  }

  async function loadRepos() {
    setRepoError(undefined)
    setRepos(undefined)
    try {
      setRepos(api?.repos ? await api.repos.list() : [])
    } catch (error) {
      setRepos([])
      setRepoError(messageOf(error))
    }
  }

  async function signOut() {
    const auth = api?.auth
    if (!auth) return
    try {
      await auth.logout()
    } catch (error) {
      showToast({ variant: "error", title: "Sign out failed", description: messageOf(error) })
      return
    }
    setAuthStatus({ configured: true, authenticated: false })
    setRepos(undefined)
    setRepoError(undefined)
    setSelection(undefined)
    setResult(undefined)
    setSearch("")
    setMode("signed-out")
  }

  async function pushViaOauth(event: SubmitEvent) {
    event.preventDefault()
    const current = selection()
    if (!api?.pushOauth || !current || !oauthReady()) return
    setPushing(true)
    setResult(undefined)
    let next: GitlabPublishResult
    try {
      next = await api.pushOauth({
        projectPath: props.projectPath,
        repo:
          current.kind === "repo"
            ? {
                pathWithNamespace: current.repo.pathWithNamespace,
                httpUrl: current.repo.httpUrl,
                webUrl: current.repo.webUrl,
              }
            : undefined,
        createNew:
          current.kind === "create"
            ? { name: name().trim(), private: isPrivate(), description: description().trim() || undefined }
            : undefined,
        commitMessage: commitMessage().trim() || undefined,
      })
    } catch (error) {
      next = { ok: false, error: messageOf(error), log: "" }
    }
    setResult(next)
    setPushing(false)
    if (!next.ok) {
      showToast({
        variant: "error",
        title: "GitLab push failed",
        description: next.error || "GitLab did not accept the push.",
      })
      return
    }
    showToast({
      variant: "success",
      title: "Pushed to GitLab",
      description: "Your current project files are committed and available on GitLab.",
    })
  }

  onMount(() => void initialize())

  return (
    <Dialog
      title="Push to GitLab"
      description={dialogDescription()}
      class="w-full max-w-[560px] mx-auto [&_[data-slot=dialog-body]]:min-h-0 [&_[data-slot=dialog-body]]:overflow-y-auto [&_[data-slot=dialog-body]]:overscroll-contain"
    >
      <Switch>
        <Match when={mode() === "checking"}>
          <div class="flex items-center justify-center gap-3 p-10">
            <Spinner class="size-4 text-text-weak" />
            <span class="text-13-regular text-text-weak">Checking GitLab…</span>
          </div>
        </Match>

        <Match when={mode() === "unavailable"}>
          <div class="flex flex-col items-center gap-4 p-8 pt-4 text-center">
            <Icon name="gitlab" size="large" />
            <div class="text-16-medium text-text-strong">GitLab isn't available</div>
            <p class="max-w-[380px] text-13-regular text-text-weak">
              {unavailableReason() ?? "GitLab publishing isn't available in this build."}
            </p>
            <Button type="button" variant="primary" onClick={() => dialog.close()}>
              Close
            </Button>
          </div>
        </Match>

        <Match when={mode() === "signed-out"}>
          <div class="flex flex-col items-center gap-4 p-8 pt-4 text-center">
            <Icon name="gitlab" size="large" />
            <div class="text-16-medium text-text-strong">Connect GitLab</div>
            <p class="max-w-[380px] text-13-regular text-text-weak">
              Authorize Vector with your GitLab account to create projects and push this project. No command-line tools
              required.
            </p>
            <Show when={authError()}>
              <div class="w-full rounded-lg border border-[rgba(236,94,94,0.35)] bg-[rgba(236,94,94,0.08)] px-4 py-3 text-12-regular text-text-strong">
                {authError()}
              </div>
            </Show>
            <div class="flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={() => dialog.close()}>
                Close
              </Button>
              <Button type="button" variant="primary" onClick={() => void startAuth()} disabled={starting()}>
                {starting() ? "Contacting GitLab…" : "Connect GitLab"}
              </Button>
            </div>
          </div>
        </Match>

        <Match when={mode() === "device-code"}>
          <div class="flex flex-col items-center gap-4 p-8 pt-4 text-center">
            <div class="text-13-regular text-text-weak">
              Enter this code at <span class="text-13-medium text-text-strong">gitlab.com/oauth/device</span>
            </div>
            <div class="flex items-center gap-2">
              <div class="select-all rounded-lg border border-border-weak-base bg-surface-base px-5 py-3 font-mono text-[24px] font-medium tracking-[0.3em] text-text-strong">
                {deviceCode()?.userCode}
              </div>
              <Button type="button" size="small" onClick={() => void copyCode()}>
                {copied() ? "Copied" : "Copy"}
              </Button>
            </div>
            <Show when={deviceCode()?.expiresIn}>
              <div class="text-11-regular text-text-weak">
                Code expires in about {Math.max(1, Math.round((deviceCode()?.expiresIn ?? 0) / 60))} minutes.
              </div>
            </Show>
            <Button type="button" onClick={() => void openVerification()}>
              Open GitLab
            </Button>
            <Show
              when={authError()}
              fallback={
                <div class="flex items-center gap-2 text-12-regular text-text-weak">
                  <Spinner class="size-3.5" />
                  Waiting for you to authorize…
                </div>
              }
            >
              <div class="w-full rounded-lg border border-[rgba(236,94,94,0.35)] bg-[rgba(236,94,94,0.08)] px-4 py-3 text-12-regular text-text-strong">
                {authError()}
              </div>
              <Button type="button" size="small" onClick={() => void startAuth()} disabled={starting()}>
                {starting() ? "Contacting GitLab…" : "Try again"}
              </Button>
            </Show>
            <Button type="button" variant="ghost" onClick={() => dialog.close()}>
              Cancel
            </Button>
          </div>
        </Match>

        <Match when={mode() === "picker"}>
          <form onSubmit={pushViaOauth} class="flex flex-col gap-4 p-6 pt-2">
            <div class="flex items-center justify-between gap-3 rounded-lg border border-border-weak-base bg-surface-base px-4 py-2.5">
              <div class="flex min-w-0 items-center gap-2">
                <Show when={authStatus()?.avatarUrl}>
                  <img src={authStatus()?.avatarUrl} alt="" class="size-5 shrink-0 rounded-full" />
                </Show>
                <span class="truncate text-13-medium text-text-strong">
                  Connected as {authStatus()?.login ?? "GitLab"}
                </span>
              </div>
              <Button type="button" variant="ghost" size="small" onClick={() => void signOut()} disabled={pushing()}>
                Sign out
              </Button>
            </div>

            <div role="radiogroup" aria-label="Destination project" class="flex flex-col gap-2">
              <TextField
                label="Search projects"
                hideLabel
                value={search()}
                onChange={setSearch}
                disabled={pushing()}
                placeholder="Search projects…"
              />

              <div class="max-h-[200px] overflow-y-auto rounded-lg border border-border-weak-base">
                <Show
                  when={repos()}
                  fallback={
                    <div class="flex items-center gap-2 px-4 py-3 text-12-regular text-text-weak">
                      <Spinner class="size-3.5" />
                      Loading projects…
                    </div>
                  }
                >
                  <Show when={repoError()}>
                    <div class="flex items-center justify-between gap-3 px-4 py-3">
                      <span class="text-12-regular text-text-weak">{repoError()}</span>
                      <Button type="button" size="small" onClick={() => void loadRepos()}>
                        Retry
                      </Button>
                    </div>
                  </Show>
                  <For
                    each={filteredRepos()}
                    fallback={
                      <Show when={!repoError()}>
                        <div class="px-4 py-3 text-12-regular text-text-weak">
                          {search().trim()
                            ? "No projects match your search."
                            : "No projects yet — create one below."}
                        </div>
                      </Show>
                    }
                  >
                    {(repo) => {
                      const selected = () => {
                        const current = selection()
                        return current?.kind === "repo" && current.repo.pathWithNamespace === repo.pathWithNamespace
                      }
                      return (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={selected()}
                          disabled={pushing()}
                          onClick={() => setSelection({ kind: "repo", repo })}
                          class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-raised-base-hover"
                          classList={{ "bg-surface-raised-base": selected() }}
                        >
                          <span class="grid size-3.5 shrink-0 place-items-center rounded-full border border-border-weak-base">
                            <Show when={selected()}>
                              <span class="size-2 rounded-full bg-[rgb(139,92,246)]" />
                            </Show>
                          </span>
                          <span class="min-w-0 flex-1 truncate text-13-medium text-text-strong">
                            {repo.pathWithNamespace}
                          </span>
                          <Show when={repo.private}>
                            <span class="shrink-0 rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium text-text-weak">
                              Private
                            </span>
                          </Show>
                          <Show when={relativeTime(repo.lastActivityAt)}>
                            <span class="shrink-0 text-11-regular text-text-weak">
                              {relativeTime(repo.lastActivityAt)}
                            </span>
                          </Show>
                        </button>
                      )
                    }}
                  </For>
                </Show>
              </div>

              <div class="rounded-lg border border-border-weak-base">
                <button
                  type="button"
                  role="radio"
                  aria-checked={selection()?.kind === "create"}
                  disabled={pushing()}
                  onClick={() => setSelection({ kind: "create" })}
                  class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-raised-base-hover"
                  classList={{ "bg-surface-raised-base": selection()?.kind === "create" }}
                >
                  <span class="grid size-3.5 shrink-0 place-items-center rounded-full border border-border-weak-base">
                    <Show when={selection()?.kind === "create"}>
                      <span class="size-2 rounded-full bg-[rgb(139,92,246)]" />
                    </Show>
                  </span>
                  <span class="text-13-medium text-text-strong">Create new project</span>
                </button>
                <Show when={selection()?.kind === "create"}>
                  <div class="flex flex-col gap-3 border-t border-border-weak-base px-4 py-3">
                    <TextField
                      label="Project name"
                      value={name()}
                      onChange={setName}
                      disabled={pushing()}
                      required
                    />
                    <label class="flex cursor-pointer items-center justify-between gap-4">
                      <span class="text-13-medium text-text-strong">Private project</span>
                      <input
                        type="checkbox"
                        class="size-4 accent-[rgb(139,92,246)]"
                        checked={isPrivate()}
                        disabled={pushing()}
                        onChange={(event) => setPrivate(event.currentTarget.checked)}
                      />
                    </label>
                    <TextField
                      label="Description"
                      value={description()}
                      onChange={setDescription}
                      disabled={pushing()}
                      placeholder="Optional project description"
                    />
                  </div>
                </Show>
              </div>
            </div>

            <TextField
              label="Commit message"
              value={commitMessage()}
              onChange={setCommitMessage}
              disabled={pushing()}
              placeholder="Update from Vector"
            />

            <ResultPanel result={result()} />

            <div class="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => dialog.close()} disabled={pushing()}>
                Close
              </Button>
              <Show when={result()?.ok && result()?.url}>
                <Button type="button" onClick={() => platform.openLink(result()!.url!)}>
                  Open project
                </Button>
              </Show>
              <Button type="submit" variant="primary" disabled={!oauthReady()}>
                {pushing() ? "Pushing…" : "Commit & push"}
              </Button>
            </div>
          </form>
        </Match>
      </Switch>
    </Dialog>
  )
}
