import { shouldUseCompletionJudge, VERIFIED_COMPLETION_POLICY } from "@/features/judge/verified-completion"
import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { batch, type Accessor } from "solid-js"
import { useTabs } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { usePlanMode } from "@/context/plan-mode"
import { type ContextItem, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { useSync, type DirectorySync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { emitDatabaseIntent } from "@/features/cloud/db-intent"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"
import {
  classifyTaskDifficulty,
  routeModelForImages,
  routeModelForTask,
  routeVariantForTask,
  type TaskDifficulty,
} from "@/utils/task-intelligence"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

export function resolveSubmissionAgent(input: {
  planMode: boolean
  current: string
  available: Array<{ name: string; mode: string; hidden?: boolean }>
}) {
  if (input.planMode) return "plan"
  if (input.current !== "plan") return input.current

  return (
    input.available.find((item) => item.name !== "plan" && item.mode !== "subagent" && !item.hidden)?.name ?? "build"
  )
}

export { shouldUseCompletionJudge, VERIFIED_COMPLETION_POLICY }

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  difficulty?: TaskDifficulty
  executionMode?: "normal" | "fast"
  llmJudge?: boolean
}

type FollowupSendInput = {
  client: DirectorySDK["client"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const difficulty = input.draft.difficulty ?? classifyTaskDifficulty(text)
  const agent = difficulty === "trivial" && input.draft.agent !== "plan" ? "quick" : input.draft.agent
  const llmJudge = shouldUseCompletionJudge({ enabled: input.draft.llmJudge === true, agent })
  const setBusy = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && input.sync.data.command.find((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

      await input.client.session.command({
        sessionID: input.draft.sessionID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: `${input.draft.model.providerID}/${input.draft.model.modelID}`,
        variant: input.draft.variant,
        executionMode: input.draft.executionMode,
        parts: images.map((attachment) => ({
          id: Identifier.ascending("part"),
          type: "file" as const,
          mime: attachment.mime,
          url: attachment.dataUrl,
          filename: attachment.filename,
        })),
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const baseParts = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent,
    model: { ...input.draft.model, variant: input.draft.variant },
    executionMode: input.draft.executionMode,
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: baseParts.optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    add()
  })

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }

    const preparation =
      difficulty === "trivial"
        ? undefined
        : await globalThis.window?.api?.prepareAgentTask?.(input.draft.sessionDirectory, text).catch(() => undefined)
    const syntheticText = [
      ...(preparation?.instruction ? [preparation.instruction] : []),
      ...(llmJudge ? [VERIFIED_COMPLETION_POLICY] : []),
    ]
    const requestParts = syntheticText.length
      ? buildRequestParts({
          prompt: input.draft.prompt,
          context: input.draft.context,
          images,
          text,
          sessionID: input.draft.sessionID,
          messageID,
          sessionDirectory: input.draft.sessionDirectory,
          syntheticText,
        }).requestParts
      : baseParts.requestParts

    await input.client.session.promptAsync({
      sessionID: input.draft.sessionID,
      agent,
      model: input.draft.model,
      messageID,
      parts: requestParts,
      variant: input.draft.variant,
      executionMode: input.draft.executionMode,
    })
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => boolean | void
  onAbort?: () => void
  onSubmit?: () => void
  executionMode?: Accessor<"normal" | "quick" | "fast">
  llmJudge?: Accessor<boolean>
  autoModelRouting?: Accessor<boolean>
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = input.prompt
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  const planMode = usePlanMode()
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const workspaceAvailable = async () => {
    if (!params.id) return true
    return sdk()
      .client.file.list({ path: "." })
      .then(() => true)
      .catch((err) => {
        showToast({
          title: "Project folder unavailable",
          description: formatServerError(err, language.t, "Reopen the project from its existing folder."),
          variant: "error",
          duration: 10_000,
        })
        return false
      })
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    serverSync().session.set("todo", sessionID, [])

    input.onAbort?.()

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
      return Promise.resolve()
    }
    return sdk()
      .client.session.abort({
        sessionID,
      })
      .catch(() => {})
  }

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const clearContext = (target: ReturnType<ReturnType<typeof usePrompt>["capture"]>) => {
    for (const item of target.context.items()) {
      target.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    serverSync().session.remember(info)
    const [, setStore] = serverSync().child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    const target = prompt.capture()
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })
    const currentPrompt = submission.prompt
    const context = submission.context
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const isPlanMode = planMode.enabled()
    const mode = isPlanMode ? "normal" : input.mode()
    const requestedExecutionMode = input.executionMode?.() ?? "normal"
    const executionMode = requestedExecutionMode === "fast" ? "fast" : "normal"

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    const selectedVariant = local.model.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    const difficulty =
      mode === "normal" && !text.trim().startsWith("/") ? classifyTaskDifficulty(text) : ("standard" as const)
    // Hiding a model in Settings is how the first-run tour tells people to
    // control what Vector uses, so routing must not reach past that filter and
    // pick something they deliberately turned off.
    const allModels = typeof local.model.list === "function" ? local.model.list() : [currentModel]
    const availableModels = allModels.filter(
      (item) =>
        item.id === currentModel.id ||
        typeof local.model.visible !== "function" ||
        local.model.visible({ providerID: item.provider.id, modelID: item.id }),
    )
    // Automatic routing upgrades the model for work it judges complex, which
    // spends the user's own key at up to an order of magnitude more per token.
    // Opt-in only. Image routing below is deliberately NOT gated: that one is a
    // capability fallback — without an image-capable model the request simply
    // cannot be served — rather than a cost decision made on the user's behalf.
    const taskRoute = input.autoModelRouting?.()
      ? routeModelForTask({ difficulty, current: currentModel, available: availableModels })
      : { model: currentModel, routed: false }
    const hasImageInput = images.some((attachment) => attachment.mime.startsWith("image/"))
    const imageRoute = hasImageInput
      ? routeModelForImages({ current: taskRoute.model, available: availableModels })
      : undefined
    if (hasImageInput && !imageRoute?.model) {
      showToast({
        title: "Connect an image-capable model",
        description:
          "The connected models only accept text. Choose or connect a model with image input, then send again.",
        variant: "error",
        duration: 10_000,
      })
      return
    }
    const routed = {
      model: imageRoute?.model ?? taskRoute.model,
      task: taskRoute.routed,
      image: imageRoute?.routed ?? false,
    }
    const variant = input.autoModelRouting?.()
      ? routeVariantForTask({
          difficulty,
          selected: selectedVariant,
          variants: Object.keys(routed.model.variants ?? {}),
        })
      : selectedVariant
    const model = {
      modelID: routed.model.id,
      providerID: routed.model.provider.id,
    }
    // A session can remember the hidden `plan` agent after Plan Mode is turned
    // off. Never carry that read-only agent into an ordinary build submission.
    const resolvedAgent = resolveSubmissionAgent({
      planMode: isPlanMode,
      current: currentAgent.name,
      available: local.agent.list(),
    })
    const agent =
      !isPlanMode && (requestedExecutionMode === "quick" || difficulty === "trivial") ? "quick" : resolvedAgent

    if (!(await workspaceAvailable())) return

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sdk().directory

    // Connected loop: if this task is really about auth / accounts / data, let
    // the shell offer a one-click "Set up database" (Supabase) for the project.
    // Proposal only — nothing is provisioned until the user confirms in Cloud.
    if (mode === "normal" && !text.trim().startsWith("/")) {
      emitDatabaseIntent(text, projectDirectory)
    }
    const isNewSession = !params.id
    const shouldAutoAccept = !isPlanMode && isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk().client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(sdk().scope, createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk().createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        serverSync().child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    let session = input.info()
    if (!session && isNewSession) {
      const created = await client.session
        .create()
        .then((x) => x.data ?? undefined)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(sessionDirectory, created)
        session = created
        if (shouldAutoAccept) permission.enableAutoAccept(session.id, sessionDirectory)
        local.session.promote(sessionDirectory, session.id)
        layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
        const draftID = search.draftId
        if (draftID) tabs.promoteDraft(draftID, { server: tabs.draft(draftID).server, sessionId: session.id })
        else navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
        submission.retarget(prompt.capture({ dir: base64Encode(sessionDirectory), id: session.id }))
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    // A toast disappears; the composer chip is what the user reads before every
    // subsequent prompt. Leaving it on the model they picked while sending to a
    // different one meant they could not tell what they were being billed for.
    if ((routed.image || routed.task) && routed.model.id !== currentModel.id) {
      local.model.set({ providerID: routed.model.provider.id, modelID: routed.model.id }, { recent: true })
    }
    if (routed.image) {
      showToast({
        title: "Vector selected an image-capable model",
        description: `Switched to ${routed.model.name} to inspect the attached image.`,
        duration: 5_000,
      })
    } else if (routed.task) {
      showToast({
        title: "Vector routed a complex task",
        description: `Switched to ${routed.model.name} for stronger planning and implementation.`,
        duration: 5_000,
      })
    }
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
      difficulty,
      executionMode,
      llmJudge: input.llmJudge?.() ?? false,
    }

    const clearInput = () => {
      submission.clear()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      if (!submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    if (!isPlanMode && !isNewSession && mode === "normal" && input.shouldQueue?.()) {
      if (input.onQueue?.(draft) === false) return
      clearContext(submission.target())
      clearInput()
      return
    }

    input.onSubmit?.()

    if (mode === "shell") {
      clearInput()
      client.session
        .shell({
          sessionID: session.id,
          agent,
          model,
          command: text,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync().data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        client.session
          .command({
            sessionID: session.id,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: `${model.providerID}/${model.modelID}`,
            variant,
            executionMode,
            parts: images.map((attachment) => ({
              id: Identifier.ascending("part"),
              type: "file" as const,
              mime: attachment.mime,
              url: attachment.dataUrl,
              filename: attachment.filename,
            })),
          })
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync().session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    for (const item of commentItems) submission.target().context.remove(item.key)
    clearInput()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sdk().scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      }

      pending.set(pendingKey(session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([
        WorktreeState.wait(sdk().scope, sessionDirectory),
        abortWait,
        timeout,
      ]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(pendingKey(session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    void sendFollowupDraft({
      client,
      sync: sync(),
      serverSync: serverSync(),
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
    }).catch((err) => {
      pending.delete(pendingKey(session.id))
      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
