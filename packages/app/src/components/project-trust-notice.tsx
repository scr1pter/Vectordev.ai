import { createResource, createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"

/**
 * A project's own vector.json and .vector settings (agents, commands, plugins, MCP servers) can run code, so the
 * engine ignores them until the project is trusted, and keeps the user's language servers, formatters and MCP servers
 * out of it. Without this notice they would simply vanish, so it says so and offers to trust the project as it is now.
 * A project with no settings of its own is called untrusted rather than said to have settings ignored.
 */
export function ProjectTrustNotice() {
  const sdk = useSDK()
  const language = useLanguage()
  const [status, { mutate }] = createResource(sdk, (dir) =>
    dir.client.config.trust
      .get()
      .then((result) => result.data)
      .catch(() => undefined),
  )
  const [pending, setPending] = createSignal(false)

  const approve = () => {
    setPending(true)
    void sdk()
      .client.config.trust.approve()
      .then((result) => mutate(result.data))
      .catch(() =>
        showToast({
          variant: "error",
          title: language.t("project.trust.approve.failed"),
          description: language.t("project.trust.approve.failed.description"),
        }),
      )
      .finally(() => setPending(false))
  }

  return (
    <Show when={status()?.ignored}>
      <span
        class="inline-flex h-6 items-center gap-1.5 rounded-md border border-border-weak-base bg-surface-panel pl-2 pr-1 text-12-regular text-text-strong"
        role="status"
        title={language.t(
          status()?.settings === false ? "project.trust.untrusted.description" : "project.trust.ignored.description",
        )}
        data-component="project-trust-notice"
      >
        <span class="size-1.5 shrink-0 rounded-full bg-surface-warning-strong" aria-hidden="true" />
        {language.t(status()?.settings === false ? "project.trust.untrusted" : "project.trust.ignored")}
        <button
          type="button"
          class="rounded px-1.5 text-12-medium text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-50"
          disabled={pending()}
          onClick={approve}
        >
          {language.t("project.trust.approve")}
        </button>
      </span>
    </Show>
  )
}
