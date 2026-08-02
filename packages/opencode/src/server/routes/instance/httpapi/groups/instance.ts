import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const PathInfo = Schema.Struct({
  home: Schema.String,
  state: Schema.String,
  config: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
}).annotate({ identifier: "Path" })

export const VcsDiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  mode: Vcs.Mode,
  context: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

export class ApiVcsApplyError extends Schema.ErrorClass<ApiVcsApplyError>("VcsApplyError")(
  {
    name: Schema.Literal("VcsApplyError"),
    data: Schema.Struct({
      message: Schema.String,
      reason: Schema.Literals(["non-git", "not-clean"]),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiVcsCommitError extends Schema.ErrorClass<ApiVcsCommitError>("VcsCommitError")(
  {
    name: Schema.Literal("VcsCommitError"),
    data: Schema.Struct({
      message: Schema.String,
      reason: Schema.Literals(["non-git", "commit-failed"]),
    }),
  },
  { httpApiStatus: 400 },
) {}

export const InstancePaths = {
  dispose: "/instance/dispose",
  path: "/path",
  vcs: "/vcs",
  vcsStatus: "/vcs/status",
  vcsDiff: "/vcs/diff",
  vcsDiffRaw: "/vcs/diff/raw",
  vcsApply: "/vcs/apply",
  vcsCommit: "/vcs/commit",
  command: "/command",
  agent: "/agent",
  skill: "/skill",
  lsp: "/lsp",
  lspDiagnostics: "/lsp/diagnostics",
  lspHover: "/lsp/hover",
  lspDefinition: "/lsp/definition",
  lspReferences: "/lsp/references",
  lspSymbols: "/lsp/symbols",
  lspRename: "/lsp/rename",
  formatter: "/formatter",
} as const

export const InstanceApi = HttpApi.make("instance")
  .add(
    HttpApiGroup.make("instance")
      .add(
        HttpApiEndpoint.post("dispose", InstancePaths.dispose, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Instance disposed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "instance.dispose",
            summary: "Dispose instance",
            description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
          }),
        ),
        HttpApiEndpoint.get("path", InstancePaths.path, {
          query: WorkspaceRoutingQuery,
          success: PathInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "path.get",
            summary: "Get paths",
            description:
              "Retrieve the current working directory and related path information for the OpenCode instance.",
          }),
        ),
        HttpApiEndpoint.get("vcs", InstancePaths.vcs, {
          query: WorkspaceRoutingQuery,
          success: described(Vcs.Info, "VCS info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.get",
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsStatus", InstancePaths.vcsStatus, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Vcs.FileStatus), "VCS status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.status",
            summary: "Get VCS status",
            description: "Retrieve changed files in the current working tree without patches.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiff", InstancePaths.vcsDiff, {
          query: VcsDiffQuery,
          success: described(Schema.Array(Vcs.FileDiff), "VCS diff"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff",
            summary: "Get VCS diff",
            description: "Retrieve the current git diff for the working tree or against the default branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiffRaw", InstancePaths.vcsDiffRaw, {
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/x-diff; charset=utf-8" })),
            "Raw VCS diff",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff.raw",
            summary: "Get raw VCS diff",
            description: "Retrieve a raw patch for current uncommitted changes.",
          }),
        ),
        HttpApiEndpoint.post("vcsApply", InstancePaths.vcsApply, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.ApplyInput,
          success: described(Vcs.ApplyResult, "VCS patch applied"),
          error: ApiVcsApplyError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.apply",
            summary: "Apply VCS patch",
            description: "Apply a raw patch to the current working tree.",
          }),
        ),
        HttpApiEndpoint.post("vcsCommit", InstancePaths.vcsCommit, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.CommitInput,
          success: described(Vcs.CommitResult, "VCS commit result"),
          error: ApiVcsCommitError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.commit",
            summary: "Commit working tree",
            description:
              "Capture a restore point, then stage all changes and commit them to the current branch.",
          }),
        ),
        HttpApiEndpoint.get("command", InstancePaths.command, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Command.Info), "List of commands"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "command.list",
            summary: "List commands",
            description: "Get a list of all available commands in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("agent", InstancePaths.agent, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Agent.Info), "List of agents"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agents",
            summary: "List agents",
            description: "Get a list of all available AI agents in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("skill", InstancePaths.skill, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Skill.Info), "List of skills"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.skills",
            summary: "List skills",
            description: "Get a list of all available skills in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("lsp", InstancePaths.lsp, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(LSP.Status), "LSP server status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.status",
            summary: "Get LSP status",
            description: "Get LSP server status",
          }),
        ),
        HttpApiEndpoint.post("lspDiagnostics", InstancePaths.lspDiagnostics, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ file: Schema.String }),
          success: described(Schema.Array(LSP.EditorDiagnostic), "Language-server diagnostics"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.diagnostics",
            summary: "Get file diagnostics",
            description: "Open a file in its language server and return current compiler and linter diagnostics.",
          }),
        ),
        HttpApiEndpoint.post("lspHover", InstancePaths.lspHover, {
          query: WorkspaceRoutingQuery,
          payload: LSP.Request,
          success: described(Schema.NullOr(LSP.Hover), "Language-server hover information"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.hover",
            summary: "Get hover information",
            description: "Return language-server documentation and type information at a source position.",
          }),
        ),
        HttpApiEndpoint.post("lspDefinition", InstancePaths.lspDefinition, {
          query: WorkspaceRoutingQuery,
          payload: LSP.Request,
          success: described(Schema.Array(LSP.Location), "Definition locations"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.definition",
            summary: "Find definitions",
            description: "Return language-server definition targets for a source position.",
          }),
        ),
        HttpApiEndpoint.post("lspReferences", InstancePaths.lspReferences, {
          query: WorkspaceRoutingQuery,
          payload: LSP.Request,
          success: described(Schema.Array(LSP.Location), "Reference locations"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.references",
            summary: "Find references",
            description: "Return language-server references for a source position.",
          }),
        ),
        HttpApiEndpoint.post("lspSymbols", InstancePaths.lspSymbols, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ file: Schema.String }),
          success: described(Schema.Array(Schema.Union([LSP.DocumentSymbol, LSP.Symbol])), "Document symbols"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.symbols",
            summary: "Get document symbols",
            description: "Return language-server symbols for the current file outline.",
          }),
        ),
        HttpApiEndpoint.post("lspRename", InstancePaths.lspRename, {
          query: WorkspaceRoutingQuery,
          payload: LSP.RenameRequest,
          success: described(LSP.RenameResult, "Workspace rename edits"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.rename",
            summary: "Rename symbol",
            description: "Return language-server workspace edits for a safe symbol rename.",
          }),
        ),
        HttpApiEndpoint.get("formatter", InstancePaths.formatter, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Format.Status), "Formatter status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "formatter.status",
            summary: "Get formatter status",
            description: "Get formatter status",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "instance",
          description: "Experimental HttpApi instance read routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
