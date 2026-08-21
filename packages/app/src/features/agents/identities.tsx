// The identities live in session-ui so the session timeline can render them
// too; app depends on session-ui, not the other way round. Re-exported here so
// app-side callers keep a feature-local import path.
export {
  SUBAGENT_IDENTITIES,
  SubagentAvatar,
  subagentIdentity,
  type SubagentIdentity,
} from "@opencode-ai/session-ui/subagent-identity"
