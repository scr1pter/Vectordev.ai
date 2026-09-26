import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Teams } from "@vectordevai/core/teams"
import { Config } from "@/config/config"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { RootHttpApi } from "../api"
import { ConsoleSwitchPayload, TeamsApiError } from "../groups/teams"

function mapError<A, R>(effect: Effect.Effect<A, Teams.TeamsError, R>) {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new TeamsApiError({
          name: "TeamsError",
          data: { code: error.code, message: error.message },
        }),
    ),
  )
}

export const teamsHandlers = HttpApiBuilder.group(RootHttpApi, "teams", (handlers) =>
  Effect.gen(function* () {
    const teams = yield* Teams.Service
    const config = yield* Config.Service

    return handlers
      .handle("console", () =>
        mapError(teams.current()).pipe(
          Effect.map((status) => ({
            consoleManagedProviders:
              status.active?.config.provider &&
              typeof status.active.config.provider === "object" &&
              !Array.isArray(status.active.config.provider)
                ? Object.keys(status.active.config.provider)
                : [],
            ...(status.active ? { activeOrgName: status.active.name } : {}),
            switchableOrgCount: status.orgs.length,
          })),
        ),
      )
      .handle("consoleOrgs", () =>
        mapError(teams.refresh()).pipe(
          Effect.map((status) => ({
            enabled: status.enabled,
            orgs: status.account
              ? status.orgs.map((org) => ({
                  accountID: status.account!.id,
                  accountEmail: status.account!.email,
                  accountUrl: "https://vectordev.ai",
                  orgID: org.id,
                  orgName: org.name,
                  active: status.active?.id === org.id,
                }))
              : [],
          })),
        ),
      )
      .handle("consoleSwitch", ({ payload }: { payload: typeof ConsoleSwitchPayload.Type }) =>
        Effect.gen(function* () {
          if (payload.orgID !== null && !payload.accountID)
            return yield* new TeamsApiError({
              name: "TeamsError",
              data: { code: "denied", message: "Refresh Vector Teams and select a team from the verified account." },
            })
          yield* mapError(teams.select(payload.orgID, payload.accountID))
          yield* config.invalidate()
          yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
          return true
        }),
      )
  }),
)
