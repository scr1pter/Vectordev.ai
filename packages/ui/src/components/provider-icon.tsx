import type { Component, JSX } from "solid-js"
import { createMemo, splitProps } from "solid-js"
import sprite from "./provider-icons/sprite.svg"
import { iconNames } from "./provider-icons/types"
import { providerIconName } from "./provider-icon-name"

export type ProviderIconProps = JSX.SVGElementTags["svg"] & {
  id: string
}

export const ProviderIcon: Component<ProviderIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["id", "class", "classList"])
  const resolved = createMemo(() => providerIconName(local.id, iconNames))
  return (
    <svg
      data-component="provider-icon"
      {...rest}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <use href={`${sprite}#${resolved()}`} />
    </svg>
  )
}
