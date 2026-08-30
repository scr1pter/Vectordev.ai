import { createEffect, createMemo, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { nativeWindowChromeLayout } from "./native-window-chrome-layout"
import "./native-window-chrome.css"

export function NativeWindowChrome(
  props: Parameters<typeof nativeWindowChromeLayout>[0] & {
    onMouseDown?: (event: MouseEvent) => void
    onDblClick?: (event: MouseEvent) => void
  },
) {
  const layout = createMemo(() => nativeWindowChromeLayout(props))
  createEffect(() => {
    const current = layout()
    if (!current) return
    const root = document.documentElement
    const previous = root.getAttribute("data-vector-native-chrome")
    const height = root.style.getPropertyValue("--vector-native-chrome-height")
    root.setAttribute("data-vector-native-chrome", current.os)
    root.style.setProperty("--vector-native-chrome-height", `${current.height}px`)
    onCleanup(() => {
      root.removeAttribute("data-vector-native-chrome")
      if (previous !== null) root.setAttribute("data-vector-native-chrome", previous)
      root.style.removeProperty("--vector-native-chrome-height")
      if (height) root.style.setProperty("--vector-native-chrome-height", height)
    })
  })

  return (
    <Show when={layout()}>
      {(current) => (
        // A separate portal keeps native dragging available when a modal hides the app root.
        <Portal>
          <div data-vector-native-window-chrome aria-hidden="true">
            <div
              data-vector-native-window-drag
              data-tauri-drag-region
              style={{ left: `${current().left}px`, right: `${current().right}px` }}
              onMouseDown={props.onMouseDown}
              onDblClick={props.onDblClick}
            />
          </div>
        </Portal>
      )}
    </Show>
  )
}
