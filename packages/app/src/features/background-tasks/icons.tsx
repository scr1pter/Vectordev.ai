// Round-cap outline glyphs for the Background tasks panel. The shared
// @opencode-ai/ui icon set has no stop, trash, expand or pop-out glyph and
// draws square caps, so the panel ships its own.

type Props = { class?: string }

function Glyph(props: Props & { children: unknown }) {
  return (
    <svg
      class={props.class}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children as never}
    </svg>
  )
}

export function PopOutIcon() {
  return (
    <Glyph>
      <rect x="3.5" y="6.5" width="10" height="10" rx="2" />
      <path d="M6.5 6.5v-1a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-1" />
    </Glyph>
  )
}

export function DockIcon() {
  return (
    <Glyph>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M12 4v12" />
    </Glyph>
  )
}

export function ExpandIcon() {
  return (
    <Glyph>
      <path d="M11.5 3.5h5v5M16.5 3.5l-5 5M8.5 16.5h-5v-5M3.5 16.5l5-5" />
    </Glyph>
  )
}

export function CollapseIcon() {
  return (
    <Glyph>
      <path d="M15.5 8.5h-4v-4M11.5 8.5l5-5M4.5 11.5h4v4M8.5 11.5l-5 5" />
    </Glyph>
  )
}

export function CloseIcon() {
  return (
    <Glyph>
      <path d="M5 5l10 10M15 5L5 15" />
    </Glyph>
  )
}

export function ChevronIcon(props: Props) {
  return (
    <Glyph class={props.class}>
      <path d="M8 5l5 5-5 5" />
    </Glyph>
  )
}

export function TrashIcon() {
  return (
    <Glyph>
      <path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5 5.5l.8 10.1a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L15 5.5M8.5 9v5M11.5 9v5" />
    </Glyph>
  )
}

export function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor" />
    </svg>
  )
}
