import type { JSX } from "solid-js"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-[#111112]">
      <div class="relative z-10 grid h-full grid-rows-[1fr_auto_1fr] px-4">
        <div />
        <div class="flex flex-col items-center">
          <img src="/vector-logo.png" alt="" class="mb-8 size-12 rounded-xl shadow-[0_0_38px_rgba(155,108,255,0.18)]" />
          <h1 class="text-center text-[30px] font-medium leading-[1.05] tracking-normal text-[#f2f2f3] sm:text-[36px]">
            What can I do for you?
          </h1>
        </div>
        <div class="flex items-end justify-center pb-[9vh]">
          <div class={`${NEW_SESSION_CONTENT_WIDTH}`}>{props.children}</div>
        </div>
      </div>
    </div>
  )
}
