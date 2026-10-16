// Vector runs its own helpers as hidden sessions, named in `internal` by the helper: Vectorscope's reviewers, the
// codespace's inline edit and autocomplete, the browser agent's planner and the desktop swarm planner. A client may
// hide a session only under one of these names, so nothing else can keep its work out of the owner's lists.
const HELPER_NAME = /^(vectorscope|codespace|browser-agent|swarm)\.[a-z]+(-[a-z]+)*$/

export function isHelperName(internal: string) {
  return HELPER_NAME.test(internal)
}
