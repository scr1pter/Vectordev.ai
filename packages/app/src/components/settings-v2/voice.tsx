import { createSignal, onMount, Show } from "solid-js"
import { dictationAvailable } from "@/services/dictation"

// Voice in Vector is behaviour, not preferences: dictation runs on-device and
// Vel is opened from the composer. Rather than invent toggles nothing reads,
// this states plainly what each part does and where it lives — the codebase has
// an explicit rule against controls with no backing.
export function SettingsVoiceV2() {
  const [available, setAvailable] = createSignal(false)
  const [speech, setSpeech] = createSignal(false)

  onMount(() => {
    setAvailable(dictationAvailable())
    setSpeech(typeof globalThis.window !== "undefined" && "speechSynthesis" in globalThis.window)
  })

  return (
    <section class="settings-v2-page">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Voice</p>
          <h2 class="settings-v2-page-title">Talking to Vector</h2>
          <p class="settings-v2-page-subtitle">
            Dictate a prompt instead of typing it, or hold a spoken conversation with the agent working on your
            repository.
          </p>
        </div>
      </div>

      <div class="settings-v2-card settings-v2-card--wide">
        <div class="settings-v2-card-head">
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">Dictation</h3>
            <p class="settings-v2-card-description">
              The microphone button in the composer transcribes what you say into the message box.
            </p>
          </div>
        </div>
        <div class="settings-v2-card-body">
          <div class="settings-v2-row-modern">
            <div class="settings-v2-row-copy">
              <div class="settings-v2-row-title">Runs on your machine</div>
              <div class="settings-v2-row-description">
                Speech is transcribed by a Whisper model running locally. Nothing is sent to a cloud speech service.
              </div>
            </div>
          </div>
          <div class="settings-v2-row-modern">
            <div class="settings-v2-row-copy">
              <div class="settings-v2-row-title">Microphone</div>
              <div class="settings-v2-row-description">
                <Show when={available()} fallback={<>Not available in this runtime, so the composer hides the button.</>}>
                  Available. Vector asks your operating system for permission the first time you use it.
                </Show>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-v2-card settings-v2-card--wide">
        <div class="settings-v2-card-head">
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">Vel</h3>
            <p class="settings-v2-card-description">
              A spoken conversation with the agent in your current session — open it from the Vel button in the
              composer.
            </p>
          </div>
        </div>
        <div class="settings-v2-card-body">
          <div class="settings-v2-row-modern">
            <div class="settings-v2-row-copy">
              <div class="settings-v2-row-title">It is the same agent</div>
              <div class="settings-v2-row-description">
                A spoken request is treated exactly like a typed one: Vel inspects the project, edits files and runs
                commands rather than only describing what it would do.
              </div>
            </div>
          </div>
          <div class="settings-v2-row-modern">
            <div class="settings-v2-row-copy">
              <div class="settings-v2-row-title">Spoken replies</div>
              <div class="settings-v2-row-description">
                <Show when={speech()} fallback={<>This runtime has no speech synthesis, so replies are shown as text.</>}>
                  Replies are read aloud during a Vel call using your system voice, and always shown as text too.
                </Show>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
