import { Config } from "@/config/config"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { Provider } from "@/provider/provider"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/config"

export const TrustStatus = Schema.Struct({
  workspace: Schema.String,
  trusted: Schema.Boolean,
  ignored: Schema.Boolean,
  // Whether the project has settings of its own (config, .vector or skills content) that trust decides on. Without
  // them `ignored` means only the user's language servers, formatters and MCP servers are held back.
  settings: Schema.Boolean,
  // Whether the client asking may approve trust. Only the server's owner may; an invited guest reads the status, but
  // its approval is refused, so the app tells the guest that the host decides instead of asking.
  approvable: Schema.Boolean,
}).annotate({ identifier: "ProjectTrustStatus" })

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
          success: described(ConfigV1.Info, "Get config info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current Vector configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          query: WorkspaceRoutingQuery,
          payload: ConfigV1.Info,
          success: described(ConfigV1.Info, "Successfully updated config"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description: "Update Vector configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.get("trust", `${root}/trust`, {
          query: WorkspaceRoutingQuery,
          success: described(TrustStatus, "Project trust status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.trust.get",
            summary: "Get project trust",
            description:
              "Whether the project's own config and .vector content are trusted, and whether they are being ignored until they are.",
          }),
        ),
        HttpApiEndpoint.post("approveTrust", `${root}/trust`, {
          query: WorkspaceRoutingQuery,
          success: described(TrustStatus, "Project trust status after approval"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.trust.approve",
            summary: "Trust project",
            description:
              "Approve the project's config and .vector content as they are now, so Vector loads them. Any later change to anything that can run needs approval again.",
          }),
        ),
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          query: WorkspaceRoutingQuery,
          success: described(Provider.ConfigProvidersResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "vector experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
