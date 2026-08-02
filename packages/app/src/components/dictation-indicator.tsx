import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"

import type { DictationState } from "@/services/dictation"
import "./dictation-indicator.css"

const WAVE_SHAPE = [
  0.28, 0.54, 0.36, 0.72, 0.42, 0.88, 0.48, 0.66, 0.34, 0.76, 0.52, 0.94, 0.46, 0.7, 0.38, 0.82, 0.5, 0.64, 0.32, 0.58,
  0.44, 0.9, 0.54, 0.74, 0.4, 0.68, 0.36, 0.84, 0.48, 0.78, 0.42, 0.6,
]

export function DictationIndicator(props: {
  state: Exclude<DictationState, "idle">
  level?: number
  onStop: () => void
}) {
  const [elapsed, setElapsed] = createSignal(0)
  let startedAt = Date.now()
  let timer: ReturnType<typeof setInterval> | undefined

  createEffect(() => {
    if (props.state !== "listening") return
    startedAt = Date.now()
    setElapsed(0)
    if (timer) clearInterval(timer)
    timer = setInterval(() => setElapsed(Date.now() - startedAt), 250)
  })

  createEffect(() => {
    if (props.state === "listening") return
    if (timer) clearInterval(timer)
    timer = undefined
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  const time = () => {
    const seconds = Math.floor(elapsed() / 1000)
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  }

  const barHeight = (shape: number, index: number) => {
    if (props.state === "transcribing") return 5 + shape * 7
    const level = Math.max(0.08, Math.min(1, props.level ?? 0))
    const ripple = 0.72 + Math.sin(elapsed() / 180 + index * 0.9) * 0.16
    return 4 + Math.max(shape * 0.25, shape * level * ripple) * 19
  }

  return (
    <div
      class="vector-dictation-indicator"
      classList={{ "is-transcribing": props.state === "transcribing" }}
      role="status"
      aria-live="polite"
      aria-label={props.state === "listening" ? `Recording, ${time()}` : "Transcribing recording"}
    >
      <div class="vector-dictation-wave" aria-hidden="true">
        <For each={WAVE_SHAPE}>
          {(shape, index) => (
            <i
              style={{
                height: `${barHeight(shape, index())}px`,
                "animation-delay": `${index() * -45}ms`,
              }}
            />
          )}
        </For>
      </div>
      <span class="vector-dictation-time">
        <Show when={props.state === "listening"} fallback="Transcribing">
          {time()}
        </Show>
      </span>
      <button
        type="button"
        class="vector-dictation-stop"
        disabled={props.state === "transcribing"}
        title={props.state === "listening" ? "Stop and transcribe" : "Transcribing locally"}
        aria-label={props.state === "listening" ? "Stop recording and transcribe" : "Transcribing recording"}
        onClick={props.onStop}
      >
        <Show when={props.state === "listening"} fallback={<span class="vector-dictation-spinner" />}>
          <span class="vector-dictation-stop-square" />
        </Show>
      </button>
    </div>
  )
}
