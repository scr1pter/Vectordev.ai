/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { EventSessionSpend, GlobalEvent } from "@vectordevai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { directory, mount, wait } from "./sync-fixture"

function spendEvent(id: string, properties: EventSessionSpend["properties"]): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id, type: "session.spend", properties },
  }
}

test("session.spend keeps the latest spend guard report per session", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)
  try {
    emit(
      spendEvent("evt_spend_warn", {
        sessionID: "ses_root",
        state: "warn",
        message: "Approaching the spend cap: $1.64 of $2.00 spent on this run.",
        spentUsd: 1.64,
        capUsd: 2,
        steps: 7,
        unpricedSteps: 0,
        costKind: "priced",
      }),
    )
    await wait(() => sync.data.session_spend.ses_root?.state === "warn")
    expect(sync.data.session_spend.ses_root).toMatchObject({ spentUsd: 1.64, capUsd: 2, steps: 7, warned: true })

    // The next step of the same run reports "ok"; the warning is kept for the rest of the run.
    emit(
      spendEvent("evt_spend_after_warn", {
        sessionID: "ses_root",
        state: "ok",
        spentUsd: 1.8,
        capUsd: 2,
        steps: 8,
        unpricedSteps: 0,
        costKind: "priced",
      }),
    )
    await wait(() => sync.data.session_spend.ses_root?.steps === 8)
    expect(sync.data.session_spend.ses_root).toMatchObject({ state: "ok", spentUsd: 1.8, warned: true })

    // A later run with no cap replaces the report, so the stale cap and warning do not linger.
    emit(
      spendEvent("evt_spend_ok", {
        sessionID: "ses_root",
        state: "ok",
        spentUsd: 0.12,
        steps: 1,
        unpricedSteps: 0,
        costKind: "priced",
      }),
    )
    await wait(() => sync.data.session_spend.ses_root?.steps === 1)
    expect(sync.data.session_spend.ses_root).toEqual({
      sessionID: "ses_root",
      state: "ok",
      spentUsd: 0.12,
      steps: 1,
      unpricedSteps: 0,
      costKind: "priced",
      warned: false,
    })
    expect(sync.data.session_spend.ses_other).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})
