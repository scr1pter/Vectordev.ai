import { Button } from "@vectordevai/ui/button"
import { Dialog } from "@vectordevai/ui/dialog"
import { freeModelName, type FreeModelChoice } from "@vectordevai/core/free-model-choice"
import { FREE_MODEL_TRAINING_QUESTION } from "@/utils/free-model-policy-notice"

/**
 * Asked once, before the first prompt to a free model whose provider may train on prompts. Closing the dialog is the
 * same as "Don't send"; the prompt stays in the editor.
 */
export function DialogFreeModelTraining(props: { model: FreeModelChoice; onAccept: () => void; onCancel: () => void }) {
  return (
    <Dialog title={FREE_MODEL_TRAINING_QUESTION.title} description={FREE_MODEL_TRAINING_QUESTION.description} fit>
      <div data-component="free-model-training" class="flex flex-col gap-3 px-6 pb-6">
        <p class="text-14-regular text-text-weak">{freeModelName(props.model)}</p>
        <div class="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" data-action="free-model-training-cancel" onClick={props.onCancel}>
            {FREE_MODEL_TRAINING_QUESTION.cancel}
          </Button>
          <Button variant="primary" data-action="free-model-training-accept" onClick={props.onAccept}>
            {FREE_MODEL_TRAINING_QUESTION.accept}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
