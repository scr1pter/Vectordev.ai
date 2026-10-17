import type { VectorClient } from "@vectordevai/sdk/v2/client"
import { createSimpleContext } from "@vectordevai/ui/context"
import { batch, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { projectTrustAnswer, type ProjectTrustAnswer } from "./project-trust-policy"

/**
 * One store of trust answers for the whole app, so every open project, Settings and the project menus read and write
 * the same record. Answers are kept per server and trust workspace (the root the engine fingerprints), which is what
 * the engine's approval covers.
 */
export const { use: useProjectTrust, provider: ProjectTrustProvider } = createSimpleContext({
  name: "ProjectTrust",
  gate: false,
  init: () => {
    const [store, setStore, , ready] = persisted(
      Persist.global("project-trust"),
      createStore({ answers: {} as Record<string, ProjectTrustAnswer> }),
    )
    // Bumped by every approval so each open project reads its status again, wherever the approval came from.
    const [version, setVersion] = createSignal(0)
    // Workspaces with a trust dialog open, so two views of one project never ask at once.
    const asking = new Set<string>()

    const answer = (scope: ServerScope, workspace: string) =>
      projectTrustAnswer(store.answers[ScopedKey.from(scope, workspace)])
    const remember = (scope: ServerScope, workspace: string, next: ProjectTrustAnswer) => {
      if (answer(scope, workspace) === next) return
      setStore("answers", ScopedKey.from(scope, workspace), next)
    }

    return {
      ready,
      version,
      answer,
      remember,
      claim(scope: ServerScope, workspace: string) {
        const key = ScopedKey.from(scope, workspace)
        if (asking.has(key)) return false
        asking.add(key)
        return true
      },
      release(scope: ServerScope, workspace: string) {
        asking.delete(ScopedKey.from(scope, workspace))
      },
      // Approves the project's settings as they are now through the engine, which is the only thing that grants
      // trust. Resolves to the new status, or undefined when the engine could not save the approval.
      async approve(client: VectorClient, scope: ServerScope) {
        const status = await client.config.trust
          .approve()
          .then((result) => result.data)
          .catch(() => undefined)
        if (!status?.trusted) return
        batch(() => {
          setVersion((value) => value + 1)
          remember(scope, status.workspace, "trusted")
        })
        return status
      },
    }
  },
})
