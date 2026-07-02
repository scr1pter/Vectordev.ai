import { type ComponentProps } from "solid-js"

const markHref = "/vector-logo.png"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Vector"
    >
      <image href={markHref} width="64" height="64" preserveAspectRatio="xMidYMid slice" />
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
      role="img"
      aria-label="Vector"
    >
      <image href={markHref} width="96" height="96" preserveAspectRatio="xMidYMid slice" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 250 64"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
      role="img"
      aria-label="vector.ai"
    >
      <image href={markHref} x="0" y="0" width="64" height="64" preserveAspectRatio="xMidYMid slice" />
      <text
        x="78"
        y="42"
        fill="currentColor"
        font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        font-size="34"
        font-weight="690"
        letter-spacing="0"
      >
        vector.ai
      </text>
    </svg>
  )
}
