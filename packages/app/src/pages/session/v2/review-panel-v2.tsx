import { createEffect, createMemo, createSignal, Show, type JSX } from "solid-js"
import type { SnapshotFileDiff, VcsFileDiff } from "@vectordevai/sdk/v2"
import { SessionReviewV2 } from "@vectordevai/session-ui/v2/session-review-v2"
import { SessionReviewFilePreviewV2 } from "@vectordevai/session-ui/v2/session-review-file-preview-v2"
import { SessionReviewListV2, type SessionReviewChangeMode } from "@vectordevai/session-ui/v2/session-review-list-v2"
import type {
  SessionReviewComment,
  SessionReviewCommentActions,
  SessionReviewCommentDelete,
  SessionReviewCommentUpdate,
  SessionReviewDiffStyle,
  SessionReviewFocus,
  SessionReviewLineComment,
} from "@vectordevai/session-ui/session-review"
import { useSDK } from "@/context/sdk"
import { filterRenderableDiff, filterReviewFiles } from "@/pages/session/v2/review-diff-kinds"
import type { ReviewPanelV2State } from "@/pages/session/v2/review-panel-v2-state"

type ReviewDiff = SnapshotFileDiff | VcsFileDiff

export type ReviewPanelV2Props = {
  mode: SessionReviewChangeMode
  /** The change modes offered; with more than one, the list's summary switches them. */
  modes?: SessionReviewChangeMode[]
  onModeChange?: (mode: SessionReviewChangeMode) => void
  empty?: JSX.Element
  footer?: JSX.Element
  diffs: () => ReviewDiff[]
  diffsReady: () => boolean
  activeFile?: string
  onSelectFile: (path: string) => void
  /** Back to the list: clears the active file. */
  onCloseFile?: () => void
  /** Opens the file in the editor. */
  onOpenFile?: (path: string) => void
  diffStyle: SessionReviewDiffStyle
  onDiffStyleChange?: (style: SessionReviewDiffStyle) => void
  state: ReviewPanelV2State
  onLineComment?: (comment: SessionReviewLineComment) => void
  onLineCommentUpdate?: (comment: SessionReviewCommentUpdate) => void
  onLineCommentDelete?: (comment: SessionReviewCommentDelete) => void
  lineCommentActions?: SessionReviewCommentActions
  comments?: SessionReviewComment[]
  focusedComment?: SessionReviewFocus | null
  onFocusedCommentChange?: (focus: SessionReviewFocus | null) => void
}

export function ReviewPanelV2(props: ReviewPanelV2Props) {
  const sdk = useSDK()

  const diffs = createMemo(() => props.diffs().filter(filterRenderableDiff))
  const filteredFiles = createMemo(() =>
    filterReviewFiles(
      diffs().map((diff) => diff.file),
      props.state.filter(),
    ),
  )
  // The reader shows exactly when a file is active: a fresh panel opens on the list,
  // and a file that leaves the diff set falls back to it.
  const activeDiff = createMemo(() => {
    // A focused comment takes over the reader until the reader applies it and
    // clears the focus; the owner then persists the file as the active selection.
    const focus = props.focusedComment
    if (focus && diffs().some((diff) => diff.file === focus.file)) return focus.file
    const active = props.activeFile
    if (active && diffs().some((diff) => diff.file === active)) return active
  })
  const activeItem = createMemo(() => diffs().find((diff) => diff.file === activeDiff()))
  // The order `<` / `>`, the pager and "Next in Changes" step through: the filtered
  // list, unless the open file is filtered out (opened from the timeline or the tree).
  const order = createMemo(() => {
    const files = filteredFiles()
    const active = activeDiff()
    if (!active || files.includes(active)) return files
    return diffs().map((diff) => diff.file)
  })
  const orderedDiffs = createMemo(() => {
    const files = new Set(order())
    return diffs().filter((diff) => files.has(diff.file))
  })

  // Once the diff set settles, drop a focused comment or an open file it does not
  // contain (committed, reverted, another mode). The list mounts no reader to clear
  // such a focus, and either would otherwise reopen the reader by itself when the
  // file changes again.
  createEffect(() => {
    if (!props.diffsReady()) return
    const files = new Set(diffs().map((diff) => diff.file))
    const focus = props.focusedComment
    if (focus) {
      if (!files.has(focus.file)) props.onFocusedCommentChange?.(null)
      return
    }
    const active = props.activeFile
    if (active && !files.has(active)) props.onCloseFile?.()
  })

  // The row of the file read last stays marked, and `<` / `>` in the list step from it.
  createEffect(() => {
    const file = activeDiff()
    if (file) props.state.setLastOpened(file)
  })

  const [explicitHighlight, setExplicitHighlight] = createSignal<string | undefined>()
  const highlighted = createMemo(() => {
    if (props.state.filter().trim().length === 0) return
    const files = filteredFiles()
    const explicit = explicitHighlight()
    if (explicit && files.includes(explicit)) return explicit
    return files[0]
  })

  const readFile = async (path: string) =>
    sdk()
      .client.file.read({ path })
      .then((x) => x.data)
      .catch((error) => {
        console.debug("[session-review-v2] failed to read file", { path, error })
        return undefined
      })

  return (
    <SessionReviewV2
      activeFile={activeDiff()}
      lastOpened={props.state.lastOpened()}
      files={order()}
      onSelectFile={props.onSelectFile}
      onCloseFile={props.onCloseFile}
      hasDiffs={diffs().length > 0}
      list={
        <SessionReviewListV2
          diffs={diffs()}
          files={filteredFiles()}
          mode={props.mode}
          modes={props.modes}
          onModeChange={props.onModeChange}
          filter={props.state.filter()}
          onFilterChange={props.state.setFilter}
          onFilterKeyDown={(event) => {
            if (!highlighted()) return
            applyFileListKeyDown(event, filteredFiles(), highlighted(), {
              onHighlight: setExplicitHighlight,
              onSelect: props.onSelectFile,
            })
          }}
          highlighted={highlighted()}
          expanded={props.state.expanded()}
          onExpandedChange={props.state.setExpanded}
          lastOpened={props.state.lastOpened()}
          onOpenFile={props.onSelectFile}
          comments={props.comments}
          scrollTop={props.state.listScroll()}
          onScrollTopChange={props.state.setListScroll}
          empty={props.empty}
          footer={props.footer}
        />
      }
      preview={
        // Key on the file path, not the diff object identity, so refreshed diff data
        // updates the mounted reader instead of remounting the whole viewer.
        <Show when={activeDiff()} keyed>
          {(file) => (
            <Show when={activeItem()}>
              {(diff) => (
                <SessionReviewFilePreviewV2
                  file={file}
                  diff={diff()}
                  diffs={orderedDiffs()}
                  diffStyle={props.diffStyle}
                  onDiffStyleChange={props.onDiffStyleChange}
                  expandMode={props.state.expandMode()}
                  onExpandModeChange={props.state.setExpandMode}
                  onSelectFile={props.onSelectFile}
                  onCloseFile={props.onCloseFile}
                  onOpenFile={props.onOpenFile}
                  readFile={readFile}
                  onLineComment={props.onLineComment}
                  onLineCommentUpdate={props.onLineCommentUpdate}
                  onLineCommentDelete={props.onLineCommentDelete}
                  lineCommentActions={props.lineCommentActions}
                  comments={props.comments}
                  focusedComment={props.focusedComment}
                  onFocusedCommentChange={props.onFocusedCommentChange}
                />
              )}
            </Show>
          )}
        </Show>
      }
    />
  )
}

// Moves the filter's highlight through the filtered files with ArrowUp / ArrowDown,
// and opens the highlighted file with Enter.
function applyFileListKeyDown(
  event: KeyboardEvent,
  files: readonly string[],
  highlighted: string | undefined,
  options: { onHighlight: (path: string) => void; onSelect: (path: string) => void },
) {
  if (files.length === 0) return

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const currentIndex = highlighted ? files.indexOf(highlighted) : -1
    const delta = event.key === "ArrowDown" ? 1 : -1
    const start = currentIndex === -1 ? (delta > 0 ? 0 : files.length - 1) : currentIndex + delta
    const index = Math.max(0, Math.min(files.length - 1, start))
    options.onHighlight(files[index]!)
    event.preventDefault()
    return
  }

  if (event.key !== "Enter") return
  const target = highlighted ?? files[0]
  if (!target) return
  options.onSelect(target)
  event.preventDefault()
}
