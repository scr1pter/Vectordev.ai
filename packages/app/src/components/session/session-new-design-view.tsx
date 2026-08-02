import type { JSX } from "solid-js"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  return (
    <div data-component="session-new-design" class="vector-new-task relative size-full overflow-hidden">
      <div class="vector-new-task__body">
        <section class="vector-new-task__welcome" aria-labelledby="vector-new-task-title">
          <div class="vector-new-task__mark" aria-hidden="true">
            <img src="/vector-logo.png" alt="" draggable={false} />
          </div>
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
