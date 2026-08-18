export const VECTOR_AGENT_RUNTIME_ENV = {
  OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
  // Gives the agent the LSP tool (go-to-definition, find-references, hover,
  // document/workspace symbols, go-to-implementation, call hierarchy). The
  // implementation is complete in packages/opencode/src/tool/lsp.ts and is
  // registered only when this flag is set, so without it the agent falls back
  // to grepping for symbols it could resolve exactly.
  OPENCODE_EXPERIMENTAL_LSP_TOOL: "true",
} as const
