import { createSignal, onMount, Show } from "solid-js"
import { dictationAvailable } from "@/services/dictation"

// Voice in Vector is behaviour, not a preference: dictation runs on-device.
// This states what the working control does rather than inventing settings the
// runtime would ignore.
export function SettingsVoiceV2() {
  const [available, setAvailable] = createSignal(false)

  onMount(() => {
    setAvailable(dictationAvailable())
  })

  return (
    <section class="settings-v2-page">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Voice</p>
          <h2 class="settings-v2-page-title">Dictation</h2>
          <p class="settings-v2-page-subtitle">Speak a prompt into the composer and edit the text before sending.</p>
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
    </section>
  )
}
