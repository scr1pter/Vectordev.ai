import { ComponentProps, splitProps } from "solid-js"
import { usePlatform } from "@/context/platform"
import { safeExternalUrl } from "@/utils/external-url"

export interface LinkProps extends Omit<ComponentProps<"a">, "href"> {
  href: string
}

export function Link(props: LinkProps) {
  const platform = usePlatform()
  const [local, rest] = splitProps(props, ["href", "children", "class"])

  return (
    <a
      {...rest}
      href={safeExternalUrl(local.href)}
      target="_blank"
      rel="noopener noreferrer"
      class={`text-text-strong underline ${local.class ?? ""}`}
      onClick={(event) => {
        event.preventDefault()
        const href = safeExternalUrl(local.href)
        if (href) platform.openLink(href)
      }}
    >
      {local.children}
    </a>
  )
}
