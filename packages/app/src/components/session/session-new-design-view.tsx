import type { JSX } from "solid-js"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-[#111112]">
      <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_12%,rgba(155,108,255,0.08),transparent_30%),linear-gradient(180deg,rgba(255,255,255,0.022),transparent_28%)]" />
      <div class="relative z-10 grid h-full grid-rows-[1fr_auto_1fr] px-4">
        <div />
        <div class="flex flex-col items-center">
          <img src="/vector-logo.png" alt="" class="mb-10 size-11 rounded-xl shadow-[0_0_38px_rgba(155,108,255,0.22)]" />
          <h1 class="text-center text-[30px] font-medium leading-[1.05] tracking-normal text-[#f2f2f3] sm:text-[36px]">
          What should we work on?
          </h1>
          <div class="mt-7 text-center text-[22px] font-light leading-none text-white/30">/</div>
          <div class="mt-7 inline-flex items-center gap-2 text-[13px] font-medium text-white/36">
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path
                d="M5.25 3.25v3.2m0 0a1.75 1.75 0 1 1-1.75 1.75m1.75-1.75h5.5m0 0v-3.2m0 3.2a1.75 1.75 0 1 0 1.75 1.75m-7.25 1.75v2.8"
                fill="none"
                stroke="currentColor"
                stroke-width="1.35"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            Main branch
          </div>
        </div>
        <div class="flex items-end justify-center pb-[9vh]">
          <div class={`${NEW_SESSION_CONTENT_WIDTH}`}>{props.children}</div>
        </div>
      </div>
    </div>
  )
}
