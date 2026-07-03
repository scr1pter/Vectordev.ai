import { For, type Component, type JSX } from "solid-js"
import { useSettings, type VectorFontPreference, type VectorSidebarPreference, type VectorWallpaperPreference } from "@/context/settings"
import { VECTOR_ELEMENTS, VectorElementSprite, type VectorElementId } from "../vector-elements"
import "./settings-v2.css"

type Choice<T extends string> = {
  id: T
  label: string
  description: string
}

const WALLPAPERS: Choice<VectorWallpaperPreference>[] = [
  { id: "nebula", label: "Nebula", description: "Soft purple space with stars and depth." },
  { id: "aurora", label: "Aurora", description: "Clean night sky with a brighter horizon." },
  { id: "grid", label: "Grid", description: "Technical grid for focused code work." },
  { id: "void", label: "Void", description: "Plain black for maximum concentration." },
]

const SIDEBARS: Choice<VectorSidebarPreference>[] = [
  { id: "fire", label: "Fire", description: "Default 8-bit ember sidebar." },
  { id: "space", label: "Space", description: "Purple stellar sidebar glow." },
  { id: "carbon", label: "Carbon", description: "Mature graphite workspace." },
  { id: "classic", label: "Classic", description: "Simple editor-style navigation." },
]

const FONTS: Choice<VectorFontPreference>[] = [
  { id: "system", label: "Vector Default", description: "Clean app font for long sessions." },
  { id: "pixel", label: "Pixel", description: "Playful 8-bit identity for demos." },
  { id: "mono", label: "Mono", description: "Sharper engineering feel." },
]

function ChoiceGrid<T extends string>(props: {
  items: Choice<T>[]
  value: () => T
  onSelect: (id: T) => void
  preview?: (id: T) => JSX.Element
}) {
  return (
    <div class="vector-settings-choice-grid">
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            class="vector-settings-choice-card"
            data-selected={props.value() === item.id ? true : undefined}
            onClick={() => props.onSelect(item.id)}
          >
            <span class="vector-settings-choice-preview">{props.preview?.(item.id)}</span>
            <span class="vector-settings-choice-copy">
              <span class="vector-settings-choice-title">{item.label}</span>
              <span class="vector-settings-choice-description">{item.description}</span>
            </span>
          </button>
        )}
      </For>
    </div>
  )
}

export const SettingsPersonalizationV2: Component = () => {
  const settings = useSettings()

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">Personalization</h2>
      </div>

      <div class="settings-v2-tab-body">
        <section class="settings-v2-section">
          <h3 class="settings-v2-section-title">Workspace wallpaper</h3>
          <p class="vector-settings-section-copy">
            Pick the default backdrop Vector uses behind the Codex-style workspace.
          </p>
          <ChoiceGrid
            items={WALLPAPERS}
            value={settings.appearance.wallpaper}
            onSelect={settings.appearance.setWallpaper}
            preview={(id) => <span class="vector-wallpaper-swatch" data-wallpaper={id} />}
          />
        </section>

        <section class="settings-v2-section">
          <h3 class="settings-v2-section-title">Sidebar style</h3>
          <p class="vector-settings-section-copy">Give the left rail a distinct Vector feel without changing the workflow.</p>
          <ChoiceGrid
            items={SIDEBARS}
            value={settings.appearance.sidebar}
            onSelect={settings.appearance.setSidebar}
            preview={(id) => <span class="vector-sidebar-swatch" data-sidebar={id} />}
          />
        </section>

        <section class="settings-v2-section">
          <h3 class="settings-v2-section-title">Interface font</h3>
          <p class="vector-settings-section-copy">Keep Vector mature by default, or switch into a more playful pixel mode.</p>
          <ChoiceGrid
            items={FONTS}
            value={settings.appearance.fontPersonality}
            onSelect={settings.appearance.setFontPersonality}
            preview={(id) => <span class="vector-font-swatch" data-font={id}>Aa</span>}
          />
        </section>
      </div>
    </>
  )
}

export const SettingsElementsV2: Component = () => {
  const settings = useSettings()

  const setElement = (id: VectorElementId) => {
    settings.appearance.setElement(id)
    if (typeof localStorage !== "undefined") localStorage.setItem("vector.element", id)
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">Vector Elements</h2>
      </div>

      <div class="settings-v2-tab-body">
        <section class="settings-v2-section">
          <h3 class="settings-v2-section-title">Choose your Element</h3>
          <p class="vector-settings-section-copy">
            Elements are the small 8-bit companions and accents that make Vector feel less sterile while you work.
          </p>
          <div class="vector-settings-elements-grid">
            <For each={VECTOR_ELEMENTS}>
              {(item) => (
                <button
                  type="button"
                  class="vector-settings-element-card"
                  data-selected={settings.appearance.element() === item.id ? true : undefined}
                  onClick={() => setElement(item.id)}
                >
                  <VectorElementSprite id={item.id} size="medium" />
                  <span>{item.label}</span>
                </button>
              )}
            </For>
          </div>
        </section>
      </div>
    </>
  )
}
