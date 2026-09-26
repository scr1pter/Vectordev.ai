import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Teams } from "@vectordevai/schema/teams"
import { NonNegativeInt } from "@vectordevai/core/schema"
import { WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const ConsoleState = Schema.Struct({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optionalKey(Schema.String),
  switchableOrgCount: NonNegativeInt,
}).annotate({ identifier: "ConsoleState" })

const ConsoleOrgList = Schema.Struct({
  enabled: Schema.Boolean,
  orgs: Schema.Array(
    Schema.Struct({
      accountID: Teams.ID,
      accountEmail: Schema.String,
      accountUrl: Schema.String,
      orgID: Teams.ID,
      orgName: Schema.String,
      active: Schema.Boolean,
    }),
  ),
})

export const ConsoleSwitchPayload = Schema.Struct({
  accountID: Schema.optionalKey(Teams.ID),
  orgID: Schema.NullOr(Teams.ID),
})

export class TeamsApiError extends Schema.ErrorClass<TeamsApiError>("TeamsError")(
  {
    name: Schema.Literal("TeamsError"),
    data: Schema.Struct({
      code: Schema.Literals(["unavailable", "denied", "invalid", "storage"]),
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

// These paths are global so Personal recovery never needs to load failing team/project configuration.
export const TeamsApi = HttpApi.make("teams").add(
  HttpApiGroup.make("teams").add(
    HttpApiEndpoint.get("console", "/experimental/console", {
      query: WorkspaceRoutingQuery,
      success: described(ConsoleState, "Active Vector Teams metadata"),
      error: TeamsApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.console.get",
        summary: "Get active Vector Teams metadata",
        description: "Get the selected team and its configured provider IDs. Personal mode performs no hosted request.",
      }),
    ),
    HttpApiEndpoint.get("consoleOrgs", "/experimental/console/orgs", {
      query: WorkspaceRoutingQuery,
      success: described(ConsoleOrgList, "Verified Vector Teams memberships"),
      error: TeamsApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.console.listOrgs",
        summary: "List verified Vector Teams memberships",
        description:
          "Refresh signed memberships from Vector. Returns enabled:false when Teams is unavailable without an active selection or no account is signed in.",
      }),
    ),
    HttpApiEndpoint.post("consoleSwitch", "/experimental/console/switch", {
      query: WorkspaceRoutingQuery,
      payload: ConsoleSwitchPayload,
      success: described(Schema.Boolean, "Team selection saved"),
      error: TeamsApiError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.console.switchOrg",
        summary: "Switch Vector Teams or Personal workspace",
        description:
          "A team requires its verified account ID. orgID:null clears team selection locally without an account, including while offline or repairing invalid configuration.",
      }),
    ),
  ),
)
