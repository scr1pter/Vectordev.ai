import {
  DiffLineAnnotation,
  FileContents,
  FileDiffOptions,
  type SelectedLineRange,
  type VirtualFileMetrics,
} from "@pierre/diffs"
import { ComponentProps } from "solid-js"
import { lineCommentStyles } from "../components/line-comment-styles"

export type DiffProps<T = {}> = FileDiffOptions<T> & {
  before: FileContents
  after: FileContents
  annotations?: DiffLineAnnotation<T>[]
  selectedLines?: SelectedLineRange | null
  commentedLines?: SelectedLineRange[]
  onLineNumberSelectionEnd?: (selection: SelectedLineRange | null) => void
  onRendered?: () => void
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

const unsafeCSS = `
[data-diff],
[data-file] {
  /* Pierre 1.2 mixes these override targets at 12% in light mode and 20% in dark mode. */
  --diffs-bg-deletion-override: light-dark(
    color-mix(in lab, var(--diffs-bg) 33.333%, var(--diffs-deletion-base)),
    color-mix(in lab, var(--diffs-bg) 60%, var(--diffs-deletion-base))
  );
  --diffs-bg-addition-override: light-dark(
    color-mix(in lab, var(--diffs-bg) 33.333%, var(--diffs-addition-base)),
    color-mix(in lab, var(--diffs-bg) 60%, var(--diffs-addition-base))
  );
  --diffs-selection-base: var(--surface-warning-strong);
  --diffs-selection-border: var(--border-warning-base);
  --diffs-selection-number-fg: #1c1917;
  /* Use explicit alpha instead of color-mix(..., transparent) to avoid Safari's non-premultiplied interpolation bugs. */
  --diffs-bg-selection: var(--diffs-bg-selection-override, rgb(from var(--surface-warning-base) r g b / 0.65));
  --diffs-bg-selection-number: var(
    --diffs-bg-selection-number-override,
    rgb(from var(--surface-warning-base) r g b / 0.85)
  );
  --diffs-bg-selection-text: rgb(from var(--surface-warning-strong) r g b / 0.2);
}

:host([data-color-scheme='dark']) [data-diff],
:host([data-color-scheme='dark']) [data-file] {
  --diffs-selection-number-fg: #fdfbfb;
  --diffs-bg-selection: var(--diffs-bg-selection-override, rgb(from var(--solaris-dark-6) r g b / 0.65));
  --diffs-bg-selection-number: var(
    --diffs-bg-selection-number-override,
    rgb(from var(--solaris-dark-6) r g b / 0.85)
  );
}

[data-diff] ::selection,
[data-file] ::selection {
  background-color: var(--diffs-bg-selection-text);
}

::highlight(vector-find) {
  background-color: rgb(from var(--surface-warning-base) r g b / 0.35);
}

::highlight(vector-find-current) {
  background-color: rgb(from var(--surface-warning-strong) r g b / 0.55);
}

[data-diff] [data-line][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-file] [data-line][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-diff] [data-column-number][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-file] [data-column-number][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-diff] [data-line-annotation][data-comment-selected]:not([data-selected-line]) [data-annotation-content] {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-file] [data-line-annotation][data-comment-selected]:not([data-selected-line]) [data-annotation-content] {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-diff] [data-line][data-selected-line] {
  background-color: var(--diffs-bg-selection);
  box-shadow: inset 2px 0 0 var(--diffs-selection-border);
}

[data-file] [data-line][data-selected-line] {
  background-color: var(--diffs-bg-selection);
  box-shadow: inset 2px 0 0 var(--diffs-selection-border);
}

[data-diff] [data-column-number][data-selected-line] {
  background-color: var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-file] [data-column-number][data-selected-line] {
  background-color: var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-diff] [data-column-number][data-line-type='context'][data-selected-line],
[data-diff] [data-column-number][data-line-type='context-expanded'][data-selected-line],
[data-diff] [data-column-number][data-line-type='change-addition'][data-selected-line],
[data-diff] [data-column-number][data-line-type='change-deletion'][data-selected-line] {
  color: var(--diffs-selection-number-fg);
}

/* The deletion word-diff emphasis is stronger than additions; soften it while selected so the selection highlight reads consistently. */
[data-diff] [data-line][data-line-type='change-deletion'][data-selected-line] {
  --diffs-bg-deletion-emphasis: light-dark(
    rgb(from var(--diffs-deletion-base) r g b / 0.07),
    rgb(from var(--diffs-deletion-base) r g b / 0.1)
  );
}

[data-diff-header],
[data-diff],
[data-file] {
  [data-separator] {
    height: 24px;
  }
  [data-column-number] {
    background-color: var(--background-stronger);
    cursor: default !important;
  }

  &[data-interactive-line-numbers] [data-column-number] {
    cursor: default !important;
  }

  &[data-interactive-lines] [data-line] {
    cursor: auto !important;
  }
  [data-code] {
    overflow-x: auto !important;
    overflow-y: clip !important;
  }
}

${lineCommentStyles}

`

export function createDefaultOptions<T>(style: FileDiffOptions<T>["diffStyle"]) {
  return {
    theme: "Vector",
    themeType: "system",
    disableLineNumbers: false,
    overflow: "wrap",
    diffStyle: style ?? "unified",
    diffIndicators: "bars",
    lineHoverHighlight: "both",
    disableBackground: false,
    expansionLineCount: 20,
    hunkSeparators: "line-info-basic",
    lineDiffType: style === "split" ? "word-alt" : "none",
    maxLineDiffLength: 1000,
    maxLineLengthForHighlighting: 1000,
    disableFileHeader: true,
    unsafeCSS,
  } as const
}

export const styleVariables = {
  "--diffs-font-family": "var(--font-family-mono)",
  "--diffs-font-size": "var(--font-size-small)",
  "--diffs-line-height": "24px",
  "--diffs-tab-size": 2,
  "--diffs-font-features": "var(--font-family-mono--font-feature-settings)",
  "--diffs-header-font-family": "var(--font-family-sans)",
  "--diffs-gap-block": 0,
  "--diffs-min-number-column-width": "4ch",
}

// The Changes reader's skin. It is appended after the shared `unsafeCSS` in the same
// "unsafe" layer, so every rule is scoped under `[data-diff]` to outrank the shared
// rules it replaces. Only the review passes these options; other diffs keep the defaults.

// The token colours the Vector theme writes inline on each token span; the review
// re-tints them on changed rows by redefining the variables, since inline colours
// cannot be overridden by a selector.
const reviewTokenColors = [
  "--syntax-comment",
  "--syntax-constant",
  "--syntax-critical",
  "--syntax-info",
  "--syntax-keyword",
  "--syntax-object",
  "--syntax-operator",
  "--syntax-primitive",
  "--syntax-property",
  "--syntax-punctuation",
  "--syntax-regexp",
  "--syntax-string",
  "--syntax-type",
  "--syntax-unknown",
  "--syntax-variable",
  "--syntax-warning",
  "--text-base",
  "--text-strong",
]

const reviewTokenBase = reviewTokenColors.map((name) => `--vr-token${name.slice(1)}:var(${name});`).join("")

function reviewTokenTint(amount: number, color: string) {
  return reviewTokenColors
    .map((name) => `${name}:color-mix(in oklab,var(--vr-token${name.slice(1)}) ${amount}%,${color});`)
    .join("")
}

export const reviewUnsafeCSS = `
/* Pierre derives its palette (--diffs-addition-base, --diffs-bg-separator, the word-diff
   emphasis...) in :host declarations, so the overrides they read must be set on :host;
   set lower, they would be ignored and the theme's diff colours would show through. */
:host {
  color-scheme: dark;
  --vr-bg: #121117;
  --vr-add: color-mix(in srgb, #65c78e 10%, #121117);
  --vr-add-num: color-mix(in srgb, #65c78e 14%, #121117);
  --vr-add-hover: color-mix(in srgb, #65c78e 13%, #121117);
  --vr-del: color-mix(in srgb, #e6787d 10%, #121117);
  --vr-del-num: color-mix(in srgb, #e6787d 14%, #121117);
  --vr-del-hover: color-mix(in srgb, #e6787d 13%, #121117);
  --vr-hover: color-mix(in srgb, #fff 2.5%, #121117);
  --vr-sep: color-mix(in srgb, #8a84c9 5.5%, #121117);
  --diffs-addition-color-override: #65c78e;
  --diffs-deletion-color-override: #e6787d;
  --diffs-bg-addition-emphasis-override: rgba(101, 199, 142, 0.26);
  --diffs-bg-deletion-emphasis-override: rgba(230, 120, 125, 0.26);
  --diffs-bg-separator-override: var(--vr-sep);
  --diffs-bg-buffer-override: #141218;
  --diffs-bg-selection-override: rgba(182, 159, 247, 0.13);
  --diffs-bg-selection-number-override: rgba(182, 159, 247, 0.18);
  ${reviewTokenBase}
}

/* The shared unsafeCSS sets these on [data-diff], so they are replaced there. */
[data-diff],
:host([data-color-scheme='dark']) [data-diff] {
  --diffs-selection-border: #9d84ee;
  --diffs-selection-number-fg: #cbbdf9;
  --diffs-bg-selection-text: rgba(182, 159, 247, 0.32);
  /* No 2px background-coloured gap between the gutter and the code; the gutter draws a 1px rule. */
  --diffs-gap-style: none;
  background: var(--vr-bg);
}

[data-diff] :is([data-line], [data-no-newline]) {
  --diffs-line-bg: var(--vr-bg);
  color: #d6d3db;
}

[data-diff] [data-line][data-hovered]:not([data-line-type^='change']) {
  --diffs-line-bg: var(--vr-hover);
}

/* Only the regular mono face ships, so a theme's italic would be synthesized. */
[data-diff] [data-line] span[style*='italic'] {
  font-style: normal !important;
}

[data-diff] :is([data-column-number], [data-gutter-buffer]) {
  background-color: var(--vr-bg);
  color: rgba(135, 133, 144, 0.6);
  font-size: 11px;
  padding: 0 8px 0 10px;
  box-shadow: inset -1px 0 0 rgba(255, 255, 255, 0.04);
}

[data-diff] [data-column-number][data-hovered] {
  color: #a8a6ad;
}

[data-diff] [data-line-type='change-addition']:is([data-line], [data-no-newline]) {
  --diffs-line-bg: var(--vr-add);
  ${reviewTokenTint(70, "#a8e2bf")}
  color: #a8e2bf;
}

[data-diff] [data-line-type='change-addition']:is([data-line], [data-no-newline])[data-hovered] {
  --diffs-line-bg: var(--vr-add-hover);
}

[data-diff] [data-line-type='change-addition']:is([data-column-number], [data-gutter-buffer]) {
  background-color: var(--vr-add-num);
  color: rgba(101, 199, 142, 0.75);
  box-shadow:
    inset 2px 0 0 #65c78e,
    inset -1px 0 0 rgba(255, 255, 255, 0.04);
}

[data-diff] [data-line-type='change-deletion']:is([data-line], [data-no-newline]) {
  --diffs-line-bg: var(--vr-del);
  ${reviewTokenTint(55, "#f0b0b3")}
  color: #f0b0b3;
}

[data-diff] [data-line-type='change-deletion']:is([data-line], [data-no-newline])[data-hovered] {
  --diffs-line-bg: var(--vr-del-hover);
}

[data-diff] [data-line-type='change-deletion']:is([data-column-number], [data-gutter-buffer]) {
  background-color: var(--vr-del-num);
  color: rgba(230, 120, 125, 0.66);
  box-shadow:
    inset 2px 0 0 #e6787d,
    inset -1px 0 0 rgba(255, 255, 255, 0.04);
}

/* Unified view has one number column: a deleted row's old number shows on hover only.
   A deleted file has no other numbers, so the reader sets --vr-deleted-numbers: 1. */
[data-diff][data-diff-type='single'] [data-column-number][data-line-type='change-deletion']:not([data-hovered]) [data-line-number-content] {
  opacity: var(--vr-deleted-numbers, 0);
}

/* The comment "+" sits over the number column of the row it belongs to. */
[data-diff] [data-gutter-utility-slot] {
  left: 0;
  justify-content: center;
}

[data-diff] [data-column-number]:has(> [data-gutter-utility-slot]) [data-line-number-content] {
  opacity: 0;
}

/* On a deleted row in unified view the hovered row shows its old number, and the
   comment "+" takes its place only once the pointer is on the number column. */
[data-diff][data-diff-type='single']
  [data-column-number][data-line-type='change-deletion']:not(:hover)
  > [data-gutter-utility-slot] {
  visibility: hidden;
}

[data-diff][data-diff-type='single']
  [data-column-number][data-line-type='change-deletion']:not(:hover):has(> [data-gutter-utility-slot])
  [data-line-number-content] {
  opacity: 1;
}

[data-diff] [data-line][data-line-type='change-addition']::before {
  color: rgba(101, 199, 142, 0.85);
}

[data-diff] [data-line][data-line-type='change-deletion']::before {
  content: '\\2212';
  color: rgba(230, 120, 125, 0.85);
}

[data-diff] [data-diff-span] {
  border-radius: 2px;
}

/* Hanging indent: wrapped lines start 2ch right of the first; the sign stays at the left. */
[data-diff][data-overflow='wrap'] [data-line] {
  padding-inline-start: 4ch;
  padding-inline-end: 12px;
  text-indent: -2ch;
}

/* The sign box inherits the indent and would shift under the gutter. */
[data-diff][data-overflow='wrap'] [data-line]::before {
  text-indent: 0;
}

/* Wrapped lines never scroll sideways; a stable gutter would leave an untinted strip
   at the end of every row where scrollbars take room (Windows, Linux). */
[data-diff][data-overflow='wrap'] [data-code] {
  scrollbar-gutter: auto;
}

/* Selected and commented ranges lay violet over the add/delete tint instead of replacing it. */
[data-diff] [data-line][data-selected-line],
[data-diff] [data-line][data-comment-selected]:not([data-selected-line]) {
  background-color: var(--diffs-line-bg);
  box-shadow: inset 0 0 0 9999px rgba(182, 159, 247, 0.13);
}

[data-diff] [data-column-number][data-selected-line],
[data-diff] [data-column-number][data-comment-selected]:not([data-selected-line]) {
  background-color: color-mix(in srgb, #b69ff7 18%, #121117);
  color: #cbbdf9;
  box-shadow:
    inset 2px 0 0 #9d84ee,
    inset -2px 0 0 #9274ec;
}

[data-diff] [data-gutter-buffer='annotation'] {
  background-color: var(--vr-bg);
  box-shadow: inset -2px 0 0 #9274ec;
}

/* Split view draws the annotation row on both sides, and the gutter cannot tell
   which side holds the comment, so neither gets the rail. */
[data-diff][data-diff-type='split'] [data-gutter-buffer='annotation'] {
  box-shadow: inset -1px 0 0 rgba(255, 255, 255, 0.04);
}

[data-diff] [data-line-annotation] {
  background-color: var(--vr-bg);
}

/* The comment card brings its own margins. */
[data-diff] [data-annotation-slot] {
  padding: 0;
}

/* Fold bars are pierre's line-info-basic separators. */
[data-diff] [data-separator] {
  height: 28px;
}

[data-diff] [data-separator]:is([data-separator='line-info-basic'], [data-separator='line-info']) {
  box-shadow:
    inset 0 1px 0 rgba(226, 213, 237, 0.06),
    inset 0 -1px 0 rgba(226, 213, 237, 0.06);
}

[data-diff] :is([data-separator-wrapper], [data-separator-content], [data-expand-button]) {
  background-color: var(--vr-sep);
}

[data-diff] [data-unmodified-lines] {
  color: #878590;
  font: 11px/28px var(--vcx-font, system-ui);
}

[data-diff] [data-expand-button] {
  color: #8a84c9;
}

[data-diff] :is([data-expand-index] [data-separator-content], [data-expand-button]):hover {
  background-color: color-mix(in srgb, #b69ff7 10%, #121117);
  color: #b69ff7;
}

[data-diff] [data-expand-index] [data-separator-content]:hover [data-unmodified-lines] {
  color: #b69ff7;
}

[data-diff] [data-separator='simple'] {
  height: 8px;
  background: #17151c;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    inset 0 -1px 0 rgba(255, 255, 255, 0.06);
}

/* Split view's empty sides: flat, no hatching. */
[data-diff] :is([data-content-buffer], [data-gutter-buffer='buffer']) {
  background-image: none;
  background-color: #141218;
}

::highlight(vector-find) {
  background-color: rgba(214, 169, 92, 0.3);
}

::highlight(vector-find-current) {
  background-color: rgba(214, 169, 92, 0.55);
}
`

/** Diff options for the Changes reader; spread over the defaults on the review's `File` only. */
export const reviewDiffOptions = {
  themeType: "dark",
  diffIndicators: "classic",
  lineDiffType: "word-alt",
  overflow: "wrap",
  unsafeCSS: unsafeCSS + reviewUnsafeCSS,
} as const

/** Row heights matching `reviewUnsafeCSS` and the review's 20px lines, for the virtualizer. */
export const reviewVirtualMetrics = {
  lineHeight: 20,
  hunkSeparatorHeight: 28,
  spacing: 0,
} satisfies Partial<VirtualFileMetrics>
