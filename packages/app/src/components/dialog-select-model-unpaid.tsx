import type { Component } from "solid-js"
import { useLocal } from "@/context/local"
import { decode64 } from "@/utils/base64"
import { DialogSelectProvider } from "./dialog-select-provider"

type ModelState = ReturnType<typeof useLocal>["model"]

export const DialogSelectModelUnpaid: Component<{ model?: ModelState }> = () => {
  const local = useLocal()
  return <DialogSelectProvider directory={() => decode64(local.slug())} />
}
