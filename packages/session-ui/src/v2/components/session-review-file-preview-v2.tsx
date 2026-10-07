import { getDirectory, getFilename } from "@vectordevai/core/util/path"
import type { SelectedLineRange } from "@pierre/diffs"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import type { FileContent, SnapshotFileDiff, VcsFileDiff } from "@vectordevai/sdk/v2"
import { useFileComponent } from "@vectordevai/ui/context/file"
import { useI18n } from "@vectordevai/ui/context/i18n"
import { Icon } from "@vectordevai/ui/icon"
import { KeybindV2 } from "@vectordevai/ui/v2/keybind-v2"
import { LineCommentV2OverflowIcon } from "@vectordevai/ui/v2/line-comment-v2"
import { MenuV2 } from "@vectordevai/ui/v2/menu-v2"
import { TooltipV2 } from "@vectordevai/ui/v2/tooltip-v2"
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { normalize, text, type ViewDiff } from "../../components/session-diff"
import type {
  SessionReviewComment,
  SessionReviewCommentActions,
  SessionReviewCommentDelete,
  SessionReviewCommentUpdate,
  SessionReviewDiffStyle,
  SessionReviewFocus,
  SessionReviewLineComment,
} from "../../components/session-review"
import { reviewDiffOptions, reviewVirtualMetrics } from "../../pierre"
import { mediaKindFromPath } from "../../pierre/media"
import { cloneSelectedLineRange, previewSelectedLines } from "../../pierre/selection-bridge"
import { createLineCommentControllerV2 } from "./line-comment-annotations-v2"
import {
  editable,
  overlay,
  reviewChangeStarts,
  scrollToReviewChange,
  type SessionReviewExpandMode,
} from "./session-review-v2"
import "./session-review-v2.css"

type ReviewDiff = (SnapshotFileDiff & { file: string }) | VcsFileDiff

export type SessionReviewFilePreviewV2Props = {
  file: string
  diff: ReviewDiff
  /** The reviewable diffs in list order; the pager and the "Next in Changes" card step through them. */
  diffs?: ReviewDiff[]
  /** The chosen style. Below `SPLIT_MIN_WIDTH` the reader renders unified whatever it is. */
  diffStyle: SessionReviewDiffStyle
  onDiffStyleChange?: (style: SessionReviewDiffStyle) => void
  expandMode?: SessionReviewExpandMode
  onExpandModeChange?: (mode: SessionReviewExpandMode) => void
  onSelectFile?: (file: string) => void
  /** Back to the list: the header's Back button and the last file's "All reviewed" card. */
  onCloseFile?: () => void
  /** Opens the file in the editor. */
  onOpenFile?: (file: string) => void
  readFile?: (path: string) => Promise<FileContent | undefined>
  onLineComment?: (comment: SessionReviewLineComment) => void
  onLineCommentUpdate?: (comment: SessionReviewCommentUpdate) => void
  onLineCommentDelete?: (comment: SessionReviewCommentDelete) => void
  lineCommentActions?: SessionReviewCommentActions
  comments?: SessionReviewComment[]
  focusedComment?: SessionReviewFocus | null
  onFocusedCommentChange?: (focus: SessionReviewFocus | null) => void
}

/** Split view needs a reader this wide (its full width, as an 840px panel gives it); a narrower one renders unified. */
const SPLIT_MIN_WIDTH = 820

const STATUS_KEY = {
  added: "ui.sessionReviewV2.newFile",
  deleted: "ui.sessionReviewV2.deletedFile",
} as const

function selectionSide(range: SelectedLineRange) {
  return range.endSide ?? range.side ?? "additions"
}

function selectionPreview(diff: ViewDiff, range: SelectedLineRange) {
  const side = selectionSide(range)
  const contents = text(diff, side)
  if (contents.length === 0) return undefined
  return previewSelectedLines(contents, range)
}

function ReviewCommentMenuV2(props: {
  labels: SessionReviewCommentActions
  onEdit: VoidFunction
  onDelete: VoidFunction
}) {
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <MenuV2 gutter={4}>
        <MenuV2.Trigger
          as="button"
          type="button"
          data-slot="line-comment-v2-overflow"
          aria-label={props.labels.moreLabel}
        >
          <LineCommentV2OverflowIcon />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.Item onSelect={props.onEdit}>{props.labels.editLabel}</MenuV2.Item>
            <MenuV2.Item onSelect={props.onDelete}>{props.labels.deleteLabel}</MenuV2.Item>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </div>
  )
}

export function SessionReviewFilePreviewV2(props: SessionReviewFilePreviewV2Props) {
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  let scrollRef: HTMLDivElement | undefined
  let headerRef: HTMLDivElement | undefined
  let backRef: HTMLButtonElement | undefined
  let focusToken = 0
  let scrollFrame = 0
  // Undefined until mounted, so the diff renders once in the right style.
  const [width, setWidth] = createSignal<number>()

  const [store, setStore] = createStore({
    selection: null as SelectedLineRange | null,
    commenting: null as SelectedLineRange | null,
    opened: null as string | null,
  })

  const view = createMemo(() => ({
    ...normalize(props.diff),
    preloaded: "preloaded" in props.diff ? props.diff.preloaded : undefined,
  }))
  const diffCanRender = createMemo(() => view().additions !== 0 || view().deletions !== 0)
  const mediaKind = createMemo(() => mediaKindFromPath(props.file))
  const comments = createMemo(() => (props.comments ?? []).filter((comment) => comment.file === props.file))
  const commentedLines = createMemo(() => comments().map((comment) => comment.selection))
  const lineCommentsEnabled = () => props.onLineComment != null
  const position = createMemo(() => (props.diffs ?? []).findIndex((diff) => diff.file === props.file))
  const sibling = (offset: -1 | 1) => (position() < 0 ? undefined : props.diffs?.[position() + offset])
  const wide = () => (width() ?? 0) >= SPLIT_MIN_WIDTH
  const changeStarts = createMemo(() => reviewChangeStarts(view().fileDiff))
  const status = () => {
    const value = view().status
    if (value === "added" || value === "deleted") return value
  }

  const commentsUi = createLineCommentControllerV2<SessionReviewComment>({
    comments,
    label: i18n.t("ui.lineComment.submit"),
    draftKey: () => props.file,
    state: {
      opened: () => store.opened,
      setOpened: (id) => setStore("opened", id),
      selected: () => store.selection,
      setSelected: (range) => setStore("selection", range),
      commenting: () => store.commenting,
      setCommenting: (range) => setStore("commenting", range),
    },
    getSide: selectionSide,
    onSubmit: ({ comment, selection }) => {
      props.onLineComment?.({
        file: props.file,
        selection,
        comment,
        preview: selectionPreview(view(), selection),
      })
    },
    onUpdate: ({ id, comment, selection }) => {
      props.onLineCommentUpdate?.({
        id,
        file: props.file,
        selection,
        comment,
        preview: selectionPreview(view(), selection),
      })
    },
    onDelete: (comment) => {
      props.onLineCommentDelete?.({
        id: comment.id,
        file: props.file,
      })
    },
    // Closing an editor unmounts its textarea and drops focus on the body, where the
    // reader's keys still work but mod+F would search the chat: hand it to the diff.
    onEditorClose: () =>
      requestAnimationFrame(() => {
        const active = document.activeElement
        if (active && active !== document.body) return
        scrollRef?.querySelector<HTMLElement>('[data-component="file"]')?.focus({ preventScroll: true })
      }),
    editSubmitLabel: props.lineCommentActions?.saveLabel,
    renderCommentActions: props.lineCommentActions
      ? (comment, controls) => (
          <ReviewCommentMenuV2 labels={props.lineCommentActions!} onEdit={controls.edit} onDelete={controls.remove} />
        )
      : undefined,
  })

  onCleanup(() => {
    focusToken++
    cancelAnimationFrame(scrollFrame)
  })

  onMount(() => {
    if (!scrollRef) return
    const scroll = scrollRef
    setWidth(scroll.offsetWidth)
    createResizeObserver(scroll, () => setWidth(scroll.offsetWidth))
    // Take focus only from the view this reader replaced: unmounting the list or the
    // previous file leaves focus on the body. A file opened from elsewhere (the
    // timeline, the tree) must not pull focus out of the composer.
    const active = document.activeElement
    const root = scrollRef.closest('[data-component="session-review-v2"]')
    if (active && active !== document.body && !root?.contains(active)) return
    backRef?.focus({ preventScroll: true })
  })

  // The header lifts off the body and fills its progress rule as the diff scrolls.
  const onScroll = () => {
    if (scrollFrame) return
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0
      if (!scrollRef || !headerRef) return
      const max = scrollRef.scrollHeight - scrollRef.clientHeight
      headerRef.toggleAttribute("data-scrolled", scrollRef.scrollTop > 0)
      headerRef.style.setProperty("--vcx-progress", `${max > 0 ? Math.min(scrollRef.scrollTop / max, 1) : 0}`)
    })
  }

  const seekChange = (direction: -1 | 1) => {
    if (scrollRef) scrollToReviewChange(scrollRef, direction, changeStarts())
  }

  // [ and ] jump between changes (the menu advertises them). Capture phase, like the
  // panel's < and >, so the session's type-to-focus never takes the key to the composer.
  makeEventListener(
    document,
    "keydown",
    (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key !== "[" && event.key !== "]") return
      if (editable(event.target) || overlay(event.target)) return
      event.preventDefault()
      seekChange(event.key === "[" ? -1 : 1)
    },
    { capture: true },
  )

  createEffect(() => {
    const focus = props.focusedComment
    if (!focus) return
    if (focus.file !== props.file) {
      // The focused file has no mounted preview (e.g. not in the current diff
      // set); clear the focus anyway so it cannot hijack a later diff refresh.
      // V1 clears unconditionally the same way.
      untrack(() => {
        const token = focusToken
        requestAnimationFrame(() => {
          if (token !== focusToken) return
          props.onFocusedCommentChange?.(null)
        })
      })
      return
    }

    untrack(() => {
      setStore("opened", focus.id)

      const comment = (props.comments ?? []).find((item) => item.file === focus.file && item.id === focus.id)
      if (comment) setStore("selection", cloneSelectedLineRange(comment.selection))

      // The diff renders asynchronously, so poll for the comment anchor before
      // scrolling; clear the focus once handled so revisiting the file does not
      // re-open a stale comment (mirrors the v1 review behavior).
      focusToken++
      const token = focusToken
      const scrollTo = (attempt: number) => {
        if (token !== focusToken) return
        const anchor = scrollRef?.querySelector(`[data-comment-id="${focus.id}"]`)
        if (scrollRef && anchor instanceof HTMLElement) {
          // Centre it in the reader only: scrollIntoView would also scroll every
          // scrollable ancestor, and the session route (overflow hidden, taller than
          // the window while the terminal is mounted) would shift up off-screen.
          const top = anchor.getBoundingClientRect().top - scrollRef.getBoundingClientRect().top
          scrollRef.scrollTop += top + anchor.offsetHeight / 2 - scrollRef.clientHeight / 2
          return
        }
        if (attempt >= 120) return
        requestAnimationFrame(() => scrollTo(attempt + 1))
      }
      requestAnimationFrame(() => scrollTo(0))
      requestAnimationFrame(() => {
        if (token !== focusToken) return
        props.onFocusedCommentChange?.(null)
      })
    })
  })

  const expandUnchanged = () => props.expandMode === "expand"

  const diffViewer = () => (
    <Dynamic
      component={fileComponent}
      mode="diff"
      {...reviewDiffOptions}
      class="vector-review-diff"
      classList={{ "vector-review-deleted": view().status === "deleted" }}
      virtualMetrics={reviewVirtualMetrics}
      fileDiff={view().fileDiff}
      preloadedDiff={view().preloaded}
      diffStyle={wide() && props.diffStyle === "split" ? "split" : "unified"}
      expandUnchanged={expandUnchanged()}
      hunkSeparators={view().fileDiff.isPartial ? "simple" : "line-info-basic"}
      enableLineSelection={lineCommentsEnabled()}
      enableGutterUtility={lineCommentsEnabled()}
      onLineSelected={(range: SelectedLineRange | null) => {
        if (!lineCommentsEnabled()) return
        commentsUi.onLineSelected(range)
      }}
      onLineSelectionEnd={(range: SelectedLineRange | null) => {
        if (!lineCommentsEnabled()) return
        commentsUi.onLineSelectionEnd(range)
      }}
      onLineNumberSelectionEnd={commentsUi.onLineNumberSelectionEnd}
      annotations={commentsUi.annotations()}
      renderAnnotation={commentsUi.renderAnnotation}
      renderGutterUtility={lineCommentsEnabled() ? commentsUi.renderGutterUtility : undefined}
      selectedLines={store.selection}
      commentedLines={commentedLines()}
      media={{
        mode: "auto",
        path: props.file,
        deleted: view().status === "deleted",
        readFile: view().status === "deleted" ? undefined : props.readFile,
      }}
    />
  )

  return (
    <>
      <div ref={headerRef} data-slot="session-review-v2-file-header">
        <Show when={props.onCloseFile}>
          <TooltipV2 value={withKey(i18n.t("ui.sessionReviewV2.backToChanges"), "Esc")}>
            <button
              ref={backRef}
              type="button"
              data-slot="session-review-v2-back"
              aria-label={i18n.t("ui.sessionReviewV2.backToChanges")}
              onClick={() => props.onCloseFile?.()}
            >
              <Icon name="arrow-left" size="small" />
            </button>
          </TooltipV2>
        </Show>
        <div data-slot="session-review-v2-file-title">
          <div data-slot="session-review-v2-file-heading">
            <span data-slot="session-review-v2-file-name">{getFilename(props.file)}</span>
            <Show when={status()}>
              {(value) => (
                <span data-slot="session-review-v2-file-status" data-type={value()}>
                  {i18n.t(STATUS_KEY[value()])}
                </span>
              )}
            </Show>
          </div>
          <Show when={props.file.includes("/")}>
            <span data-slot="session-review-v2-file-path">{getDirectory(props.file)}</span>
          </Show>
        </div>
        {/* A new or deleted file has only one side to count. */}
        <Show when={status() !== "deleted"}>
          <span data-slot="session-review-v2-add">+{view().additions}</span>
        </Show>
        <Show when={status() !== "added"}>
          <span data-slot="session-review-v2-del">−{view().deletions}</span>
        </Show>
        <Show when={position() >= 0}>
          <span data-slot="session-review-v2-file-divider" aria-hidden="true" />
          <div
            data-slot="session-review-v2-file-pager"
            role="group"
            aria-label={i18n.t("ui.sessionReviewV2.filesInChanges")}
          >
            <TooltipV2 value={withKey(i18n.t("ui.sessionReviewV2.previousFile"), "<")}>
              <button
                type="button"
                aria-label={i18n.t("ui.sessionReviewV2.previousFile")}
                disabled={!sibling(-1)}
                onClick={() => {
                  const previous = sibling(-1)
                  if (previous) props.onSelectFile?.(previous.file)
                }}
              >
                <Icon name="chevron-down" size="small" style={{ transform: "rotate(180deg)" }} />
              </button>
            </TooltipV2>
            <span data-slot="session-review-v2-file-position">
              {position() + 1}/{props.diffs?.length ?? 0}
            </span>
            <TooltipV2 value={withKey(i18n.t("ui.sessionReviewV2.nextFile"), ">")}>
              <button
                type="button"
                aria-label={i18n.t("ui.sessionReviewV2.nextFile")}
                disabled={!sibling(1)}
                onClick={() => {
                  const next = sibling(1)
                  if (next) props.onSelectFile?.(next.file)
                }}
              >
                <Icon name="chevron-down" size="small" />
              </button>
            </TooltipV2>
          </div>
        </Show>
        <Show when={props.onOpenFile}>
          <TooltipV2 value={i18n.t("ui.sessionReviewV2.openInEditor")}>
            <button
              type="button"
              aria-label={i18n.t("ui.sessionReviewV2.openInEditor")}
              onClick={() => props.onOpenFile?.(props.file)}
            >
              <Icon name="open-file" size="small" />
            </button>
          </TooltipV2>
        </Show>
        <MenuV2 gutter={4} placement="bottom-end">
          <TooltipV2 value={i18n.t("ui.sessionReviewV2.moreActions")}>
            <MenuV2.Trigger as="button" type="button" aria-label={i18n.t("ui.sessionReviewV2.moreActions")}>
              <Icon name="dot-grid" size="small" />
            </MenuV2.Trigger>
          </TooltipV2>
          <MenuV2.Portal>
            <MenuV2.Content class="session-review-v2-menu">
              <Show when={props.onExpandModeChange}>
                <MenuV2.CheckboxItem
                  checked={expandUnchanged()}
                  onChange={(checked) => props.onExpandModeChange?.(checked ? "expand" : "collapse")}
                >
                  {i18n.t("ui.sessionReviewV2.showFullFile")}
                </MenuV2.CheckboxItem>
              </Show>
              <Show when={props.onDiffStyleChange}>
                {/* Checked only when it shows: a persisted split stays unified below the width. */}
                <MenuV2.CheckboxItem
                  checked={wide() && props.diffStyle === "split"}
                  disabled={!wide()}
                  onChange={(checked) => props.onDiffStyleChange?.(checked ? "split" : "unified")}
                >
                  {i18n.t("ui.sessionReviewV2.splitView")}
                </MenuV2.CheckboxItem>
                <Show when={!wide()}>
                  <p data-slot="session-review-v2-menu-hint">{i18n.t("ui.sessionReviewV2.splitNeedsWidth")}</p>
                </Show>
              </Show>
              <Show when={props.onExpandModeChange || props.onDiffStyleChange}>
                <MenuV2.Separator />
              </Show>
              <MenuV2.Item shortcut="[" onSelect={() => seekChange(-1)}>
                {i18n.t("ui.sessionReviewV2.previousChange")}
              </MenuV2.Item>
              <MenuV2.Item shortcut="]" onSelect={() => seekChange(1)}>
                {i18n.t("ui.sessionReviewV2.nextChange")}
              </MenuV2.Item>
              <MenuV2.Separator />
              <MenuV2.Item onSelect={() => navigator.clipboard?.writeText(props.file).catch(() => {})}>
                {i18n.t("ui.sessionReviewV2.copyPath")}
              </MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </div>
      <div ref={scrollRef} data-slot="session-review-v2-diff-scroll" onScroll={onScroll}>
        <div data-slot="session-review-v2-diff-card">
          <Show when={width() !== undefined}>
            <Show
              when={diffCanRender() || mediaKind()}
              fallback={<div data-slot="session-review-v2-binary">{i18n.t("ui.fileMedia.binary.title")}</div>}
            >
              {diffViewer()}
            </Show>
          </Show>
        </div>
        <Show when={position() >= 0}>
          <Show
            when={sibling(1)}
            fallback={
              <Show when={props.onCloseFile}>
                <button
                  type="button"
                  data-slot="session-review-v2-next"
                  data-done=""
                  onClick={() => props.onCloseFile?.()}
                >
                  <Icon name="check" size="small" />
                  <span data-slot="session-review-v2-next-done">
                    {i18n.t("ui.sessionReviewV2.endOfChanges")}
                    <span> · {i18n.t("ui.sessionReviewV2.backToChanges")}</span>
                  </span>
                </button>
              </Show>
            }
          >
            {(next) => (
              <>
                <p data-slot="session-review-v2-next-label">{i18n.t("ui.sessionReviewV2.nextInChanges")}</p>
                <button
                  type="button"
                  data-slot="session-review-v2-next"
                  onClick={() => props.onSelectFile?.(next().file)}
                >
                  <span data-slot="session-review-v2-next-name">
                    {getFilename(next().file)}
                    <Show when={next().file.includes("/")}>
                      <span>{getDirectory(next().file)}</span>
                    </Show>
                  </span>
                  <span data-slot="session-review-v2-add">+{next().additions}</span>
                  <span data-slot="session-review-v2-del">−{next().deletions}</span>
                  <Icon name="arrow-right" size="small" />
                </button>
              </>
            )}
          </Show>
        </Show>
      </div>
    </>
  )
}

function withKey(label: string, key: string): JSX.Element {
  return (
    <>
      {label}
      <KeybindV2 keys={[key]} variant="neutral" />
    </>
  )
}
