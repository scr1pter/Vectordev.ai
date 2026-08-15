import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { createMemo, createSignal } from "solid-js"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"
import { isPullRequestReference, normalizePullRequestReference } from "./dialog-github-review.utils"

export function DialogGithubReview(props: { sessionID: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const local = useLocal()
  const [reference, setReference] = createSignal("")
  const [publish, setPublish] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)
  const valid = createMemo(() => isPullRequestReference(reference()) && !submitting())

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!valid()) return
    const model = local.model.current()
    if (!model) {
      showToast({
        variant: "error",
        title: "Choose a model",
        description: "Select a connected model before starting the pull-request review.",
      })
      return
    }

    setSubmitting(true)
    const target = normalizePullRequestReference(reference())
    await sdk()
      .client.session.command({
        sessionID: props.sessionID,
        command: "review",
        arguments: publish() ? `--publish ${target}` : target,
        agent: "review",
        model: `${model.provider.id}/${model.id}`,
        variant: local.model.variant.current(),
        executionMode: "normal",
      })
      .then(() => {
        dialog.close()
        showToast({
          variant: "success",
          title: "Pull-request review started",
          description: publish()
            ? "Vector will inspect the PR and publish its final review summary to GitHub."
            : "Vector is reading the PR, repository context, and validation evidence in this session.",
        })
      })
      .catch((error) => {
        showToast({
          variant: "error",
          title: "Could not start PR review",
          description: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => setSubmitting(false))
  }

  return (
    <Dialog
      title="Review a GitHub pull request"
      description="Vector reads the real PR diff and surrounding files, runs relevant checks, and reports actionable findings in this session."
      class="w-full max-w-[520px] mx-auto"
    >
      <form class="flex flex-col gap-4 p-6 pt-2" onSubmit={submit}>
        <TextField
          autofocus
          label="Pull request"
          value={reference()}
          onChange={setReference}
          placeholder="GitHub PR URL or number"
          disabled={submitting()}
          required
        />
        <label class="flex items-start justify-between gap-4 rounded-lg border border-border-weak-base px-4 py-3">
          <span>
            <span class="block text-13-medium text-text-strong">Publish the review summary to GitHub</span>
            <span class="mt-1 block text-12-regular text-text-weak">
              Explicitly allows Vector to post one review comment after its evidence pass. It never merges or approves the PR.
            </span>
          </span>
          <input
            type="checkbox"
            class="mt-0.5 size-4 accent-[rgb(139,92,246)]"
            checked={publish()}
            disabled={submitting()}
            onChange={(event) => setPublish(event.currentTarget.checked)}
          />
        </label>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => dialog.close()} disabled={submitting()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid()}>
            {submitting() ? "Starting review…" : "Review pull request"}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
