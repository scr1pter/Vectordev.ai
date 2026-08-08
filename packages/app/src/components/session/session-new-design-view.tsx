import type { JSX } from "solid-js"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

// The backdrop V: a pixel-mosaic glyph rendered from a grid map, echoing the
// brand wordmark. "1" cells form the arms; "2" cells are detached drift pixels
// around the edges. Colors sweep light lavender (top-left) to deep violet
// (bottom-right), with per-cell jitter so the mosaic reads hand-set, not tiled.
const PIXEL_V_GRID = [
  "111.2.....111",
  "1111......111",
  ".1111.2..1111",
  ".1111....111.",
  "2.1111..1111.",
  "..11111.1111.",
  "...111111111.",
  "...11111111.2",
  "....111111...",
  "2...11111....",
  ".....111.....",
  ".....11......",
]

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const channel = (from: number, to: number, t: number) => Math.round(lerp(from, to, t))

// #f3ecff -> #b892ff -> #6633cc, biased so the left arm stays brightest.
const cellColor = (t: number) => {
  if (t < 0.5) {
    const k = t / 0.5
    return `rgb(${channel(243, 184, k)}, ${channel(236, 146, k)}, ${channel(255, 255, k)})`
  }
  const k = (t - 0.5) / 0.5
  return `rgb(${channel(184, 102, k)}, ${channel(146, 51, k)}, ${channel(255, 204, k)})`
}

const hash = (x: number, y: number) => {
  const value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return value - Math.floor(value)
}

const pixelVCells = () =>
  PIXEL_V_GRID.flatMap((row, y) =>
    row.split("").flatMap((cell, x) => {
      if (cell === ".") return []
      const drift = cell === "2"
      const t = Math.min(1, (x / 12) * 0.52 + (y / 11) * 0.48)
      const jitter = hash(x, y)
      const size = (drift ? 0.52 : 0.86) + jitter * 0.12
      return [
        {
          x: x + (1 - size) / 2,
          y: y + (1 - size) / 2,
          size,
          fill: cellColor(Math.max(0, Math.min(1, t + (jitter - 0.5) * 0.12))),
          opacity: drift ? 0.4 + jitter * 0.25 : 0.82 + jitter * 0.18,
        },
      ]
    }),
  )

function PixelVBackdrop() {
  const cells = pixelVCells()
  return (
    <div class="vector-new-task__pixelv" aria-hidden="true">
      <svg viewBox="-1 -1 15 14" xmlns="http://www.w3.org/2000/svg">
        <g filter="url(#vector-pixelv-bloom)" opacity="0.85">
          {cells.map((cell) => (
            <rect
              x={cell.x}
              y={cell.y}
              width={cell.size}
              height={cell.size}
              rx={cell.size * 0.16}
              fill={cell.fill}
              opacity={cell.opacity}
            />
          ))}
        </g>
        {cells.map((cell) => (
          <rect
            x={cell.x}
            y={cell.y}
            width={cell.size}
            height={cell.size}
            rx={cell.size * 0.16}
            fill={cell.fill}
            opacity={cell.opacity}
          />
        ))}
        <defs>
          <filter id="vector-pixelv-bloom" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="0.65" />
          </filter>
        </defs>
      </svg>
    </div>
  )
}

export function NewSessionDesignView(props: { children: JSX.Element }) {
  return (
    <div data-component="session-new-design" class="vector-new-task relative size-full overflow-hidden">
      <PixelVBackdrop />
      <div class="vector-new-task__body">
        <section class="vector-new-task__welcome" aria-labelledby="vector-new-task-title">
          <div class="vector-new-task__eyebrow">Vector Agent</div>
          <h1 id="vector-new-task-title">What should we build?</h1>
          <p>Plan a feature, repair a bug, or ask Vector to work across the project.</p>
        </section>
        <div class="vector-new-task__composer">
          <div class={`${NEW_SESSION_CONTENT_WIDTH}`}>{props.children}</div>
        </div>
      </div>
    </div>
  )
}
