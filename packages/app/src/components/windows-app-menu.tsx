import { useCommand } from "@/context/command"
import { usePlatform } from "@/context/platform"

export function WindowsAppMenu(_props: {
  command: ReturnType<typeof useCommand>
  platform: ReturnType<typeof usePlatform>
  variant?: "legacy" | "v2"
}) {
  return null
}
