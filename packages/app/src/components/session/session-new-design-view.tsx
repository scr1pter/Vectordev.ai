import type { JSX } from "solid-js"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-[#0d0d10]">
      <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_8%,rgba(155,108,255,0.16),transparent_36%),linear-gradient(180deg,rgba(255,255,255,0.035),transparent_24%)]" />
      <div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#9b6cff]/40 to-transparent" />
      <div class="relative z-10 flex h-full flex-col items-center justify-center px-4 pb-[8vh]">
        <div class="mb-8 flex items-center gap-3 rounded-full border border-v2-border-border-muted bg-v2-background-bg-layer-01/55 px-3 py-2 shadow-[0_18px_60px_rgba(0,0,0,0.28)] backdrop-blur-xl">
          <img src="/vector-logo.png" alt="" class="size-8 rounded-xl" />
          <span class="text-[13px] font-semibold tracking-normal text-v2-text-text-base">vector.ai</span>
        </div>
        <h1 class="text-center text-[34px] font-medium leading-[1.04] tracking-normal text-v2-text-text-base sm:text-[44px]">
          What should we work on?
        </h1>
        <p class="mt-3 max-w-[560px] text-center text-[14px] leading-6 text-v2-text-text-muted">
          Plan the task, generate code, inspect every diff, and preview the app from one calm workspace.
        </p>
        <div class={`${NEW_SESSION_CONTENT_WIDTH} mt-9`}>{props.children}</div>
      </div>
    </div>
  )
}
