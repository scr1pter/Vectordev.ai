export * as ConfigImport from "./import-settings"

import { Effect } from "effect"
import { ConfigMigration } from "@vectordevai/core/config/migration"
import { GlobalBus } from "@/bus/global"
import { TuiEvent } from "@/server/tui-event"

function notify(result: { message: string } | undefined) {
  if (!result) return
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: TuiEvent.ToastShow.type,
      properties: { message: result.message, variant: "info", duration: 12000 },
    },
  })
}

export const run = Effect.fn("ConfigImport.run")(function* (directory: string, local = false) {
  const result = yield* ConfigMigration.run(directory, local)
  notify(result)
  return result
})

export const discover = Effect.fn("ConfigImport.discover")(function* (
  input: Parameters<typeof ConfigMigration.discover>[0],
) {
  const results = yield* ConfigMigration.discover(input)
  results.forEach(notify)
})
