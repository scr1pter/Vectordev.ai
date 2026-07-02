import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="1" y="1" width="46" height="46" rx="14" fill="url(#vectorMarkGradient)" />
      <rect x="18" y="18" width="12" height="12" rx="2" stroke="var(--icon-strong-base)" stroke-width="4" />
      <path
        d="M24 9v7M24 32v7M9 24h7M32 24h7M14 14l5 5M34 34l-5-5M34 14l-5 5M14 34l5-5"
        stroke="var(--icon-strong-base)"
        stroke-width="3.4"
        stroke-linecap="round"
      />
      <defs>
        <linearGradient id="vectorMarkGradient" x1="1" y1="1" x2="47" y2="47" gradientUnits="userSpaceOnUse">
          <stop stop-color="#E6D8FF" />
          <stop offset="1" stop-color="#8F52FF" />
        </linearGradient>
      </defs>
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 96 96"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="8" y="8" width="80" height="80" rx="24" fill="url(#vectorSplashGradient)" />
      <rect x="36" y="36" width="24" height="24" rx="4" stroke="var(--icon-strong-base)" stroke-width="8" />
      <path
        d="M48 18v14M48 64v14M18 48h14M64 48h14M28 28l10 10M68 68 58 58M68 28 58 38M28 68l10-10"
        stroke="var(--icon-strong-base)"
        stroke-width="7"
        stroke-linecap="round"
      />
      <defs>
        <linearGradient id="vectorSplashGradient" x1="8" y1="8" x2="88" y2="88" gradientUnits="userSpaceOnUse">
          <stop stop-color="#E6D8FF" />
          <stop offset="1" stop-color="#8F52FF" />
        </linearGradient>
      </defs>
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 210 48"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <rect x="1" y="1" width="46" height="46" rx="14" fill="url(#vectorLogoGradient)" />
      <rect x="18" y="18" width="12" height="12" rx="2" stroke="var(--icon-strong-base)" stroke-width="4" />
      <path
        d="M24 9v7M24 32v7M9 24h7M32 24h7M14 14l5 5M34 34l-5-5M34 14l-5 5M14 34l5-5"
        stroke="var(--icon-strong-base)"
        stroke-width="3.4"
        stroke-linecap="round"
      />
      <text
        x="62"
        y="31"
        fill="var(--text-strong-base)"
        font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        font-size="26"
        font-weight="700"
        letter-spacing="-1"
      >
        vector.ai
      </text>
      <defs>
        <linearGradient id="vectorLogoGradient" x1="1" y1="1" x2="47" y2="47" gradientUnits="userSpaceOnUse">
          <stop stop-color="#E6D8FF" />
          <stop offset="1" stop-color="#8F52FF" />
        </linearGradient>
      </defs>
    </svg>
  )
}
