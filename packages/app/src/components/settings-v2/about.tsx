import { For } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { usePlatform } from "@/context/platform"
import "./settings-v2.css"

const notices = [
  ["Vector", "Proprietary desktop application"],
  ["OpenCode", "MIT License - retained for incorporated upstream portions"],
  ["Electron", "MIT License"],
  ["Solid", "MIT License"],
  ["Stripe SDK", "MIT License"],
  ["CodeMirror and Monaco Editor", "MIT License"],
] as const

export function SettingsAboutV2() {
  const platform = usePlatform()
  const open = (path: string) => platform.openLink(`https://vectordev.ai${path}`)

  return (
    <section class="settings-v2-page settings-license-page">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Product</p>
          <h2 class="settings-v2-page-title">About Vector</h2>
          <p class="settings-v2-page-subtitle">Version, product license, and third-party software notices.</p>
        </div>
      </div>

      <div class="settings-license-content">
        <div class="settings-license-card settings-about-card">
          <img src="/vector-logo.png" alt="Vector" />
          <div>
            <h3>Vector {platform.version || "Development"}</h3>
            <p>Local-first AI engineering workspace for macOS, Windows, and Linux.</p>
          </div>
        </div>

        <div class="settings-license-card">
          <div class="settings-license-card-copy">
            <h3>Vector software license</h3>
            <p>Vector is proprietary software. A paid license grants one person access on one active computer during the subscription term.</p>
          </div>
          <div class="settings-license-buttons">
            <ButtonV2 variant="outline" icon="link" onClick={() => open("/legal/license")}>License terms</ButtonV2>
            <ButtonV2 variant="outline" icon="link" onClick={() => open("/legal/terms")}>Terms of service</ButtonV2>
            <ButtonV2 variant="outline" icon="link" onClick={() => open("/legal/privacy")}>Privacy</ButtonV2>
          </div>
        </div>

        <div class="settings-license-card">
          <div class="settings-license-card-copy">
            <h3>Third-party licenses</h3>
            <p>Vector includes open-source components under their original licenses. Those licenses remain in effect for those components.</p>
          </div>
          <div class="settings-notice-list">
            <For each={notices}>{([name, license]) => <div><strong>{name}</strong><span>{license}</span></div>}</For>
          </div>
          <ButtonV2 variant="outline" icon="link" onClick={() => open("/legal/third-party")}>Read complete notices</ButtonV2>
        </div>
      </div>
    </section>
  )
}
