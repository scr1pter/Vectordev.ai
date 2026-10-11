import { createMemo, createResource, type Accessor } from "solid-js"
import type { Session } from "@vectordevai/sdk/v2/client"
import { useSDK } from "@/context/sdk"
import { delegatedSpend, sessionTokens } from "@/utils/session-cost"

// What a session delegated, named per Vector helper. Helper sessions are in no list, so they are read as the session's
// children, again whenever its rolled-up spend moves.
export function createDelegatedSpend(info: Accessor<Session | undefined>) {
  const sdk = useSDK()
  // A string, so an update that leaves the delegated spend unchanged does not read the children again.
  const revision = createMemo(() => {
    const session = info()
    if (!session || !(session.subagentCost || session.subagentUnpricedSteps || session.subagentTokens)) return
    return [
      session.id,
      session.subagentCost ?? 0,
      session.subagentUnpricedSteps ?? 0,
      sessionTokens({ tokens: session.subagentTokens }),
    ].join(" ")
  })
  const [children] = createResource(revision, (key) =>
    sdk()
      .client.session.children({ sessionID: key.split(" ")[0] ?? "" })
      .then(
        (result) => result.data ?? [],
        () => [],
      ),
  )
  return createMemo(() =>
    delegatedSpend(
      info(),
      (children.latest ?? []).filter((child) => child.parentID === info()?.id),
    ),
  )
}
