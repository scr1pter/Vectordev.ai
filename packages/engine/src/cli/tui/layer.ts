import { run as runTui, type TuiInput } from "@vectordevai/tui"
import { Global } from "@vectordevai/core/global"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
