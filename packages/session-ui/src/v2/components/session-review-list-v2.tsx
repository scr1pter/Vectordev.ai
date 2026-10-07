import { checksum } from "@vectordevai/core/util/encode"
import { getDirectory, getFilename } from "@vectordevai/core/util/path"
import type { SnapshotFileDiff, VcsFileDiff } from "@vectordevai/sdk/v2"
import { useI18n } from "@vectordevai/ui/context/i18n"
import { Icon } from "@vectordevai/ui/icon"
import { SelectV2 } from "@vectordevai/ui/v2/select-v2"
import { TextInputV2 } from "@vectordevai/ui/v2/text-input-v2"
import { For, Show, createEffect, createMemo, createSignal, on, onMount, type JSX } from "solid-js"
import { normalize } from "../../components/session-diff"
import { mediaKindFromPath } from "../../pierre/media"
import { reviewSnippet, type ReviewSnippetRow } from "./session-review-snippet"
import "./session-review-v2.css"

type ReviewDiff = (SnapshotFileDiff & { file: string }) | VcsFileDiff

export type SessionReviewChangeMode = "git" | "branch" | "turn"

export type SessionReviewListV2Props = {
  /** Every reviewable diff; the summary counts these whatever the filter. */
  diffs: ReviewDiff[]
  /** The files to list, in order, after the filter. */
  files: string[]
  mode: SessionReviewChangeMode
  /** The modes offered. With more than one, the summary label becomes a menu. */
  modes?: SessionReviewChangeMode[]
  onModeChange?: (mode: SessionReviewChangeMode) => void
  filter: string
  onFilterChange: (value: string) => void
  /** Runs after the list's own Escape handling; ArrowUp / ArrowDown / Enter belong here. */
  onFilterKeyDown?: (event: KeyboardEvent) => void
  highlighted?: string
  /** Rows showing their snippet. Kept by the owner so it survives a visit to the reader. */
  expanded: ReadonlySet<string>
  onExpandedChange: (file: string, expanded: boolean) => void
  /** The file the reader showed last; its row is marked. */
  lastOpened?: string
  /** Opens the reader on a file. */
  onOpenFile: (file: string) => void
  comments?: readonly { file: string }[]
  /** The list's scroll offset, restored when the list mounts again after Back. */
  scrollTop?: number
  onScrollTopChange?: (top: number) => void
  /** Shown instead of rows when there are no diffs: loading, empty and no-git states. */
  empty?: JSX.Element
  footer?: JSX.Element
}

const FILTER_THRESHOLD = 8

const SUMMARY_KEY = {
  git: "ui.sessionReviewV2.filesChanged",
  branch: "ui.sessionReviewV2.filesOnBranch",
  turn: "ui.sessionReviewV2.filesLastTurn",
} as const

const MODE_KEY = {
  git: "ui.sessionReview.title.git",
  branch: "ui.sessionReview.title.branch",
  turn: "ui.sessionReview.title.lastTurn",
} as const

const ROW_CLASS: Record<ReviewSnippetRow["kind"], string | undefined> = {
  ctx: undefined,
  add: "is-add",
  del: "is-del",
}

export function SessionReviewListV2(props: SessionReviewListV2Props) {
  const i18n = useI18n()
  let scrollRef: HTMLDivElement | undefined
  let filterRef: HTMLInputElement | undefined
  const [filterRequested, setFilterRequested] = createSignal(false)

  const plural = (key: string, count: number) => i18n.t(`${key}.${count === 1 ? "one" : "other"}`, { count })
  const byFile = createMemo(() => new Map(props.diffs.map((diff) => [diff.file, diff])))
  const additions = createMemo(() => props.diffs.reduce((sum, diff) => sum + diff.additions, 0))
  const deletions = createMemo(() => props.diffs.reduce((sum, diff) => sum + diff.deletions, 0))
  const commentCounts = createMemo(() =>
    (props.comments ?? []).reduce(
      (counts, comment) => counts.set(comment.file, (counts.get(comment.file) ?? 0) + 1),
      new Map<string, number>(),
    ),
  )
  const summary = () => plural(SUMMARY_KEY[props.mode], props.diffs.length)
  const switchable = () => (props.modes?.length ?? 0) > 1
  const filterShown = () => props.diffs.length > FILTER_THRESHOLD || filterRequested() || props.filter.length > 0
  // Memoize the slot getters so the Show conditions do not instantiate throwaway elements.
  const empty = createMemo(() => props.empty)
  const footer = createMemo(() => props.footer)

  onMount(() => {
    if (scrollRef && props.scrollTop) scrollRef.scrollTop = props.scrollTop
  })

  createEffect(
    on(
      () => props.highlighted,
      (file) => {
        if (!file) return
        scrollRef?.querySelector(`#${sessionReviewRowID(file)}`)?.scrollIntoView({ block: "nearest" })
      },
      { defer: true },
    ),
  )

  // "/" reveals the filter in short lists, where it is hidden.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "/" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]"))
      return
    event.preventDefault()
    setFilterRequested(true)
    queueMicrotask(() => filterRef?.focus())
  }

  // Escape clears the filter first, then leaves the field for the first row, hiding
  // a filter that "/" revealed. The side panel leaves Escape in a field alone, so
  // the panel closes only on an Escape from outside it.
  const onFilterKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && props.filter.length > 0) {
      event.preventDefault()
      props.onFilterChange("")
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      setFilterRequested(false)
      const row = scrollRef?.querySelector<HTMLElement>('[data-slot="session-review-v2-file-row"]')
      if (row) return row.focus()
      if (event.target instanceof HTMLElement) event.target.blur()
      return
    }
    props.onFilterKeyDown?.(event)
  }

  return (
    <div
      ref={scrollRef}
      data-slot="session-review-v2-list"
      onKeyDown={onKeyDown}
      onScroll={(event) => props.onScrollTopChange?.(event.currentTarget.scrollTop)}
    >
      <Show when={props.diffs.length > 0 || switchable()}>
        <div data-slot="session-review-v2-summary">
          <span data-slot="session-review-v2-summary-label">
            <Show when={switchable()} fallback={summary()}>
              <SelectV2
                class="session-review-v2-mode"
                appearance="inline"
                options={props.modes ?? []}
                current={props.mode}
                // The trigger reads as the summary; the menu names the modes.
                label={() => summary()}
                placement="bottom-start"
                gutter={6}
                onSelect={(mode) => mode && props.onModeChange?.(mode)}
              >
                {(mode) => i18n.t(MODE_KEY[mode])}
              </SelectV2>
            </Show>
          </span>
          <Show when={props.diffs.length > 0}>
            <span data-slot="session-review-v2-add">+{additions()}</span>
            <span data-slot="session-review-v2-del">−{deletions()}</span>
          </Show>
        </div>
      </Show>

      <Show when={filterShown()}>
        <div data-slot="session-review-v2-filter">
          <TextInputV2
            ref={filterRef}
            type="search"
            value={props.filter}
            onInput={(event) => props.onFilterChange(event.currentTarget.value)}
            onKeyDown={onFilterKeyDown}
            showClearButton={props.filter.length > 0}
            clearLabel={i18n.t("ui.list.clearFilter")}
            onClearClick={() => props.onFilterChange("")}
            placeholder={i18n.t("ui.sessionReviewV2.filterFiles")}
            aria-label={i18n.t("ui.sessionReviewV2.filterFiles")}
            leadingIcon={
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path
                  d="M12.25 12.25L10.0625 10.0625M11.0833 6.41667C11.0833 8.994 8.994 11.0833 6.41667 11.0833C3.83934 11.0833 1.75 8.994 1.75 6.41667C1.75 3.83934 3.83934 1.75 6.41667 1.75C8.994 1.75 11.0833 3.83934 11.0833 6.41667Z"
                  stroke="currentColor"
                  stroke-linecap="square"
                />
              </svg>
            }
          />
        </div>
      </Show>

      <Show when={props.diffs.length > 0} fallback={<div data-slot="session-review-v2-list-empty">{empty()}</div>}>
        <Show
          when={props.files.length > 0}
          fallback={<div data-slot="session-review-v2-list-empty">{i18n.t("ui.sessionReviewV2.noMatchingFiles")}</div>}
        >
          <ul data-slot="session-review-v2-files">
            <For each={props.files}>
              {(file) => {
                const diff = () => byFile().get(file)
                const snippetID = `session-review-v2-snippet-${checksum(file)}`
                // Media and binary files have no lines to preview, so their row opens the reader.
                const expandable = () => {
                  const kind = mediaKindFromPath(file)
                  if (kind === "image" || kind === "audio") return false
                  const value = diff()
                  return !!value && value.additions + value.deletions > 0
                }
                const expanded = () => expandable() && props.expanded.has(file)
                const snippet = createMemo(() => {
                  const value = diff()
                  if (!expanded() || !value) return
                  return reviewSnippet(normalize(value).fileDiff)
                })
                const more = () => {
                  const value = snippet()?.more
                  if (!value) return ""
                  const key = value.unit === "hunks" ? "ui.sessionReviewV2.moreHunks" : "ui.sessionReviewV2.moreLines"
                  return `⋯ ${plural(key, value.count)}`
                }
                const comments = () => commentCounts().get(file) ?? 0

                return (
                  <li id={sessionReviewRowID(file)}>
                    <button
                      type="button"
                      data-slot="session-review-v2-file-row"
                      aria-expanded={expandable() ? expanded() : undefined}
                      aria-controls={expandable() ? snippetID : undefined}
                      data-opened={props.lastOpened === file ? "" : undefined}
                      data-highlighted={props.highlighted === file ? "" : undefined}
                      onClick={() => {
                        if (!expandable()) return props.onOpenFile(file)
                        props.onExpandedChange(file, !expanded())
                      }}
                    >
                      <Icon name="chevron-right" data-slot="session-review-v2-file-chevron" />
                      <span data-slot="session-review-v2-file-name">
                        {getFilename(file)}
                        <Show when={file.includes("/")}>
                          <span>{getDirectory(file)}</span>
                        </Show>
                      </span>
                      <Show when={comments() > 0}>
                        <span
                          data-slot="session-review-v2-comment-count"
                          title={plural("ui.sessionReviewV2.comments", comments())}
                        >
                          <Icon name="comment" />
                          {comments()}
                        </span>
                      </Show>
                      <span data-slot="session-review-v2-add">+{diff()?.additions ?? 0}</span>
                      <span data-slot="session-review-v2-del">−{diff()?.deletions ?? 0}</span>
                    </button>
                    <Show when={expanded()}>
                      <button
                        type="button"
                        id={snippetID}
                        data-slot="session-review-v2-snippet"
                        aria-label={i18n.t("ui.sessionReviewV2.openDiffFor", { file: getFilename(file) })}
                        onClick={() => props.onOpenFile(file)}
                      >
                        <Show when={snippet()}>
                          {(value) => (
                            <>
                              <code class="is-hunk">{value().header}</code>
                              <For each={value().rows}>
                                {(row) => <code class={ROW_CLASS[row.kind]}>{row.text}</code>}
                              </For>
                            </>
                          )}
                        </Show>
                        <span class="is-more">
                          <span>{more()}</span>
                          <span class="is-open">{i18n.t("ui.sessionReviewV2.openDiff")} →</span>
                        </span>
                      </button>
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </Show>

      <Show when={footer()}>
        <footer data-slot="session-review-v2-footer">{footer()}</footer>
      </Show>
    </div>
  )
}

/** A file's row id; the legacy review uses the same one, which scroll-to-file looks up. */
export function sessionReviewRowID(file: string) {
  return `session-review-diff-${checksum(file)}`
}
