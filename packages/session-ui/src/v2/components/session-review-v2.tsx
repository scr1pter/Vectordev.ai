import type { FileDiffMetadata } from "@pierre/diffs"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Show, createEffect, on, type JSX } from "solid-js"
import { getViewerRoot } from "../../pierre/file-runtime"
import { sessionReviewRowID } from "./session-review-list-v2"
import "./session-review-v2.css"

export type SessionReviewExpandMode = "expand" | "collapse"

export type SessionReviewV2Props = {
  /** The Changes list (`SessionReviewListV2`), shown while no file is open. */
  list?: JSX.Element
  /** The reader for `activeFile` (`SessionReviewFilePreviewV2`). */
  preview?: JSX.Element
  /** The open file. The panel shows the reader exactly when this is set. */
  activeFile?: string
  /** The file the reader showed last; `<` / `>` in the list step from it. */
  lastOpened?: string
  /** Files in list order, for `<` / `>`. */
  files: string[]
  onSelectFile: (file: string) => void
  /** Back to the list (button or Esc). */
  onCloseFile?: () => void
  hasDiffs: boolean
}

export function SessionReviewV2(props: SessionReviewV2Props) {
  let root: HTMLDivElement | undefined

  // From the reader `<` / `>` step from the open file; from the list they open the
  // file before or after the last one read, or the last or first file.
  const neighbor = (direction: -1 | 1) => {
    const files = props.files
    if (files.length === 0) return
    const anchor = props.activeFile ?? props.lastOpened
    const index = anchor ? files.indexOf(anchor) : -1
    if (index < 0) return direction > 0 ? files[0] : files.at(-1)
    return files[(index + direction + files.length) % files.length]
  }

  // The pager tooltips advertise < and >; keep them working while the panel is
  // mounted, but never while typing or in a menu or dialog. The capture phase puts
  // this ahead of the session's type-to-focus, which skips a handled key; in the
  // bubble phase the first key would page and move focus to the composer, and the
  // second would be typed there. The reader handles [ and ] the same way.
  makeEventListener(
    document,
    "keydown",
    (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key !== "<" && event.key !== ">") return
      if (editable(event.target) || overlay(event.target) || !props.hasDiffs) return
      const file = neighbor(event.key === "<" ? -1 : 1)
      if (!file) return
      event.preventDefault()
      props.onSelectFile(file)
    },
    { capture: true },
  )

  // Esc goes Back from the reader. Bubble phase, so the find bar, comment editors
  // and menus handle their own Esc first; preventDefault tells the side panel this
  // Esc is spent, so only a second Esc closes the panel. Listening on the document
  // also catches the Esc that follows a click on something unfocusable in the
  // reader, which leaves focus on the body.
  makeEventListener(document, "keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !props.activeFile || !props.onCloseFile) return
    const target = event.target
    if (target !== document.body && !(target instanceof Node && root?.contains(target))) return
    if (editable(target)) return
    if (target instanceof Element && target.closest('[data-component="line-comment-v2"]')) return
    if (document.querySelector('[data-component="file-search"], [role="menu"], [role="listbox"], [role="dialog"]'))
      return
    // An open comment editor takes the Esc first, as it does from its textarea.
    const editor = root?.querySelector('[data-component="line-comment-v2"][data-variant="editor"]')
    if (editor) {
      event.preventDefault()
      editor
        .querySelector<HTMLElement>('[data-slot="line-comment-v2-footer-actions"] [data-variant="neutral"]')
        ?.click()
      return
    }
    event.preventDefault()
    props.onCloseFile()
  })

  // Back unmounts the reader and with it the focused control: hand focus to the row
  // of the file just read, unless the user has moved focus elsewhere meanwhile. Not
  // deferred: `on` records the previous file only from its first run, and a panel that
  // mounts on a file must still know which row to focus on the first Back.
  createEffect(
    on(
      () => props.activeFile,
      (file, previous) => {
        if (file || !previous) return
        const active = document.activeElement
        if (active && active !== document.body && !root?.contains(active)) return
        requestAnimationFrame(() => {
          const row = root?.querySelector<HTMLElement>(
            `#${sessionReviewRowID(previous)} > [data-slot="session-review-v2-file-row"]`,
          )
          row?.focus({ preventScroll: true })
          row?.scrollIntoView({ block: "nearest" })
        })
      },
    ),
  )

  return (
    <div ref={root} data-component="session-review-v2" data-view={props.activeFile ? "file" : "list"}>
      <div data-slot="session-review-v2-body">
        <Show when={props.activeFile} fallback={props.list}>
          {/* mod+F anywhere in the reader (Back, the header) finds in its diff. */}
          <div data-slot="session-review-v2-preview" data-find-scope>
            {props.preview}
          </div>
        </Show>
      </div>
    </div>
  )
}

const CHANGE_OFFSET = 8
// Pierre renders 1000px beyond each edge of the viewport, so a page this long leaves
// no unrendered gap between two looks.
const CHANGE_PAGE_OVERLAP = 600
const CHANGE_PAGES = 100
// A newer `[` / `]` takes over from a search still paging.
let changeSeek = 0

/**
 * Scrolls the reader to the start of the previous or next change block (`[` / `]`).
 * A block starts at a changed line whose previous line is not a change. Pierre
 * virtualizes long diffs, so when no block is rendered in that direction this pages
 * toward it and looks again, and puts the scroll back if there is none. `starts` are
 * the unified line indexes of every change block (`reviewChangeStarts`): paging
 * happens only while one lies beyond the rendered rows, so the last change does not
 * scroll through the rest of the file and back.
 */
export function scrollToReviewChange(scroll: HTMLElement, direction: -1 | 1, starts: readonly number[]) {
  const origin = scroll.scrollTop
  const token = ++changeSeek
  const seek = (page: number) => {
    if (token !== changeSeek) return
    const top = scroll.getBoundingClientRect().top - scroll.scrollTop
    const target = changeStarts(scroll)
      .map((line) => line.getBoundingClientRect().top - top - CHANGE_OFFSET)
      .toSorted((a, b) => a - b)
      .filter((y) => (direction > 0 ? y > origin + 1 : y < origin - 1))
      .at(direction > 0 ? 0 : -1)
    if (target !== undefined) {
      scroll.scrollTop = target
      return
    }
    const room = direction > 0 ? scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop : scroll.scrollTop
    if (room <= 0 || page >= CHANGE_PAGES || !beyond(scroll, direction, starts)) {
      scroll.scrollTop = origin
      return
    }
    scroll.scrollTop += direction * (scroll.clientHeight + CHANGE_PAGE_OVERLAP)
    // The virtualizer renders on the frame after the scroll event; look on the one after.
    requestAnimationFrame(() => requestAnimationFrame(() => seek(page + 1)))
  }
  seek(0)
}

/** The unified line index where each change block starts, as pierre numbers rows. */
export function reviewChangeStarts(diff: FileDiffMetadata) {
  return diff.hunks.flatMap((hunk) => {
    let index = hunk.unifiedLineStart
    return hunk.hunkContent.flatMap((block) => {
      const start = index
      index += block.type === "context" ? block.lines : block.deletions + block.additions
      return block.type === "change" ? [start] : []
    })
  })
}

// Whether a change block starts past the rendered rows in this direction. Rows carry
// `data-line-index="<unified>,<split>"`; with none rendered yet, assume there is.
function beyond(scroll: HTMLElement, direction: -1 | 1, starts: readonly number[]) {
  const indexes = Array.from(getViewerRoot(scroll)?.querySelectorAll("[data-line-index]") ?? [])
    .map((row) => Number.parseInt(row.getAttribute("data-line-index") ?? "", 10))
    .filter((index) => !Number.isNaN(index))
  if (indexes.length === 0) return true
  const edge = direction > 0 ? Math.max(...indexes) : Math.min(...indexes)
  return starts.some((start) => (direction > 0 ? start > edge : start < edge))
}

function changeStarts(scroll: HTMLElement) {
  const root = getViewerRoot(scroll)
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('[data-line][data-line-type^="change"]')).filter(
    (line) => !previousLine(line)?.dataset.lineType?.startsWith("change"),
  )
}

function previousLine(line: HTMLElement) {
  for (let el = line.previousElementSibling; el; el = el.previousElementSibling) {
    if (el instanceof HTMLElement && el.hasAttribute("data-line")) return el
  }
}

export function editable(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || !!target.closest("input, textarea, select"))
}

/** Inside a menu, listbox or dialog, whose keys are its own. */
export function overlay(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('[role="menu"], [role="listbox"], [role="dialog"]')
}
