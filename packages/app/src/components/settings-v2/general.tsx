import { Component, For, JSX, Show, createMemo, createSignal } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import {
  type VectorAnimationSpeedPreference,
  type VectorChatWidthPreference,
  type VectorCodeStylePreference,
  type VectorComponentNamingPreference,
  type VectorCursorStylePreference,
  type VectorDensityPreference,
  type VectorExplanationStylePreference,
  type VectorIndentationPreference,
  type VectorMessageSpacingPreference,
  type VectorThemePreference,
  useSettings,
} from "@/context/settings"
import { SettingsKeybinds } from "../settings-keybinds"
import "./settings-v2.css"

export type SettingsSection =
  | "general"
  | "profile"
  | "appearance"
  | "personalization"
  | "shortcuts"
  | "editor"
  | "chat"
  | "notifications"
  | "accessibility"
  | "about"

type Option = {
  value: string
  label: string
}

const themeOptions: Option[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "Follow system" },
]

const densityOptions: Option[] = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
  { value: "spacious", label: "Spacious" },
]

const animationOptions: Option[] = [
  { value: "off", label: "Off" },
  { value: "calm", label: "Calm" },
  { value: "normal", label: "Normal" },
  { value: "fast", label: "Fast" },
]

const indentationOptions: Option[] = [
  { value: "spaces", label: "Spaces" },
  { value: "tabs", label: "Tabs" },
]

const codeStyleOptions: Option[] = [
  { value: "clean", label: "Clean" },
  { value: "documented", label: "Documented" },
  { value: "minimal", label: "Minimal" },
]

const componentNamingOptions: Option[] = [
  { value: "PascalCase", label: "PascalCase" },
  { value: "camelCase", label: "camelCase" },
  { value: "kebab-case", label: "kebab-case" },
]

const cursorStyleOptions: Option[] = [
  { value: "line", label: "Line" },
  { value: "block", label: "Block" },
  { value: "underline", label: "Underline" },
]

const chatWidthOptions: Option[] = [
  { value: "focused", label: "Focused" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
]

const messageSpacingOptions: Option[] = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
  { value: "relaxed", label: "Relaxed" },
]

const explanationStyleOptions: Option[] = [
  { value: "beginner", label: "Beginner" },
  { value: "balanced", label: "Balanced" },
  { value: "pro", label: "Pro" },
]

const fontFamilyOptions: Option[] = [
  { value: "", label: "System mono" },
  { value: "JetBrains Mono", label: "JetBrains Mono" },
  { value: "SF Mono", label: "SF Mono" },
  { value: "Fira Code", label: "Fira Code" },
  { value: "Geist Mono", label: "Geist Mono" },
]

const defaultSettingsPreview = {
  accent: "#9b6cff",
  workspace: "#111112",
  sidebar: "#18181a",
  chat: "#202024",
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const pickOption = (options: Option[], value: string) => options.find((option) => option.value === value) ?? options[0]

const localKeys = () => {
  if (typeof localStorage === "undefined") return []
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(Boolean) as string[]
}

const removeMatchingLocalKeys = (patterns: RegExp[]) => {
  if (typeof localStorage === "undefined") return 0
  const keys = localKeys().filter((key) => patterns.some((pattern) => pattern.test(key)))
  for (const key of keys) localStorage.removeItem(key)
  return keys.length
}

const deviceInfo = () => {
  if (typeof navigator === "undefined") return "Unknown device"
  const memory = "deviceMemory" in navigator ? `${(navigator as Navigator & { deviceMemory?: number }).deviceMemory} GB RAM` : ""
  return [navigator.platform, memory].filter(Boolean).join(" - ") || navigator.userAgent
}

const currentModelLabel = () => {
  if (typeof localStorage === "undefined") return "Selected in prompt bar"
  const raw = localStorage.getItem("model") ?? localStorage.getItem("model.v1")
  if (!raw) return "Selected in prompt bar"
  try {
    const parsed = JSON.parse(raw)
    const recent = parsed?.state?.recent?.[0] ?? parsed?.recent?.[0]
    if (recent?.modelID) return `${recent.providerID ?? "provider"} / ${recent.modelID}`
  } catch {}
  return "Selected in prompt bar"
}

const Page: Component<{
  eyebrow: string
  title: string
  description: string
  children: JSX.Element
}> = (props) => (
  <section class="settings-v2-page">
    <div class="settings-v2-page-hero">
      <div>
        <p class="settings-v2-page-kicker">{props.eyebrow}</p>
        <h2 class="settings-v2-page-title">{props.title}</h2>
        <p class="settings-v2-page-subtitle">{props.description}</p>
      </div>
    </div>
    {props.children}
  </section>
)

const Card: Component<{
  icon?: IconProps["name"]
  title: string
  description?: string
  wide?: boolean
  children: JSX.Element
}> = (props) => (
  <div class="settings-v2-card" classList={{ "settings-v2-card--wide": !!props.wide }}>
    <div class="settings-v2-card-head">
      <Show when={props.icon} keyed>
        {(icon) => (
        <div class="settings-v2-card-icon">
          <Icon name={icon} />
        </div>
        )}
      </Show>
      <div class="settings-v2-card-copy">
        <h3 class="settings-v2-card-title">{props.title}</h3>
        <Show when={props.description}>
          <p class="settings-v2-card-description">{props.description}</p>
        </Show>
      </div>
    </div>
    <div class="settings-v2-card-body">{props.children}</div>
  </div>
)

const ToggleRow: Component<{
  title: string
  description?: string
  checked: boolean
  onChange: (value: boolean) => void
}> = (props) => (
  <div class="settings-v2-row-modern">
    <div class="settings-v2-row-copy">
      <div class="settings-v2-row-title">{props.title}</div>
      <Show when={props.description}>
        <div class="settings-v2-row-description">{props.description}</div>
      </Show>
    </div>
    <div class="settings-v2-row-control">
      <Switch checked={props.checked} onChange={props.onChange} />
    </div>
  </div>
)

const SelectRow: Component<{
  title: string
  description?: string
  options: Option[]
  value: string
  onChange: (value: string) => void
}> = (props) => (
  <div class="settings-v2-row-modern">
    <div class="settings-v2-row-copy">
      <div class="settings-v2-row-title">{props.title}</div>
      <Show when={props.description}>
        <div class="settings-v2-row-description">{props.description}</div>
      </Show>
    </div>
    <div class="settings-v2-row-control">
      <SelectV2
        appearance="inline"
        options={props.options}
        current={pickOption(props.options, props.value)}
        value={(option) => option.value}
        label={(option) => option.label}
        onSelect={(option) => option && props.onChange(option.value)}
      />
    </div>
  </div>
)

const TextRow: Component<{
  title: string
  description?: string
  value: string
  placeholder?: string
  onInput: (value: string) => void
}> = (props) => (
  <div class="settings-v2-row-modern settings-v2-row-modern--stacked">
    <div class="settings-v2-row-copy">
      <div class="settings-v2-row-title">{props.title}</div>
      <Show when={props.description}>
        <div class="settings-v2-row-description">{props.description}</div>
      </Show>
    </div>
    <TextInputV2
      appearance="large"
      class="settings-v2-input"
      value={props.value}
      placeholder={props.placeholder}
      onInput={(event) => props.onInput(event.currentTarget.value)}
    />
  </div>
)

const TextAreaRow: Component<{
  title: string
  description?: string
  value: string
  placeholder?: string
  onInput: (value: string) => void
}> = (props) => (
  <div class="settings-v2-row-modern settings-v2-row-modern--stacked">
    <div class="settings-v2-row-copy">
      <div class="settings-v2-row-title">{props.title}</div>
      <Show when={props.description}>
        <div class="settings-v2-row-description">{props.description}</div>
      </Show>
    </div>
    <textarea
      class="settings-v2-textarea"
      value={props.value}
      placeholder={props.placeholder}
      onInput={(event) => props.onInput(event.currentTarget.value)}
    />
  </div>
)

const NumberRow: Component<{
  title: string
  description?: string
  value: number
  min: number
  max: number
  step?: number
  onInput: (value: number) => void
}> = (props) => (
  <div class="settings-v2-row-modern">
    <div class="settings-v2-row-copy">
      <div class="settings-v2-row-title">{props.title}</div>
      <Show when={props.description}>
        <div class="settings-v2-row-description">{props.description}</div>
      </Show>
    </div>
    <TextInputV2
      appearance="large"
      type="number"
      class="settings-v2-number"
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      value={String(props.value)}
      onInput={(event) => props.onInput(clamp(Number(event.currentTarget.value), props.min, props.max))}
    />
  </div>
)

const RangeRow: Component<{
  title: string
  description?: string
  value: number
  min: number
  max: number
  step?: number
  format?: (value: number) => string
  onInput: (value: number) => void
}> = (props) => (
  <div class="settings-v2-row-modern settings-v2-row-modern--stacked">
    <div class="settings-v2-row-copy">
      <div class="settings-v2-row-title">{props.title}</div>
      <Show when={props.description}>
        <div class="settings-v2-row-description">{props.description}</div>
      </Show>
    </div>
    <div class="settings-v2-range-row">
      <input
        class="settings-v2-range"
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onInput={(event) => props.onInput(clamp(Number(event.currentTarget.value), props.min, props.max))}
      />
      <span class="settings-v2-range-value">{props.format ? props.format(props.value) : props.value}</span>
    </div>
  </div>
)

const ColorRow: Component<{
  title: string
  description?: string
  value: string
  onInput: (value: string) => void
}> = (props) => (
  <div class="settings-v2-row-modern">
    <div class="settings-v2-row-copy">
      <div class="settings-v2-row-title">{props.title}</div>
      <Show when={props.description}>
        <div class="settings-v2-row-description">{props.description}</div>
      </Show>
    </div>
    <label class="settings-v2-color-input">
      <input type="color" value={props.value} onInput={(event) => props.onInput(event.currentTarget.value)} />
      <span>{props.value}</span>
    </label>
  </div>
)

export const SettingsGeneralV2: Component<{
  sessionID?: string
  section?: SettingsSection
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const [status, setStatus] = createSignal("")

  const section = () => props.section ?? "general"
  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )
  const avatarInitials = createMemo(() => {
    const name = settings.profile.displayName().trim() || "Vector User"
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("")
  })

  const announce = (message: string) => {
    setStatus(message)
    window.setTimeout(() => setStatus(""), 2400)
  }

  const clearApplicationCache = () => {
    const removed = removeMatchingLocalKeys([/cache/i, /\btemp\b/i, /temporary/i])
    if (typeof sessionStorage !== "undefined") sessionStorage.clear()
    announce(`Cleared ${removed} cached local entries.`)
  }

  const resetLocalPreferences = () => {
    settings.resetAll()
    announce("Vector preferences restored.")
  }

  const onAvatarSelected = (event: Event & { currentTarget: HTMLInputElement }) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ""
    if (!file || !file.type.startsWith("image/")) return
    const reader = new FileReader()
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        settings.profile.setAvatar(reader.result)
        announce("Avatar saved locally.")
      }
    })
    reader.readAsDataURL(file)
  }

  const onBackdropSelected = (event: Event & { currentTarget: HTMLInputElement }) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ""
    if (!file || !file.type.startsWith("image/")) return
    const reader = new FileReader()
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        settings.appearance.setChatBackdrop(reader.result)
        announce("Chat backdrop updated.")
      }
    })
    reader.readAsDataURL(file)
  }

  const renderGeneral = () => (
    <Page
      eyebrow="General"
      title="Language and local data"
      description="Interface language and the data Vector stores on this device."
    >
      <div class="settings-v2-section-grid">
        <Card icon="sliders" title="Interface" description="Applies immediately across the whole workspace.">
          <SelectRow
            title="Language"
            description="Display language for menus, dialogs, and labels."
            options={languageOptions()}
            value={language.locale()}
            onChange={(value) => language.setLocale(value as Parameters<typeof language.setLocale>[0])}
          />
        </Card>
        <Card icon="reset" title="Local data" description="Preferences and caches stored on this device. Project files are never touched.">
          <div class="settings-v2-action-grid">
            <ButtonV2 variant="outline" icon="trash" onClick={clearApplicationCache}>
              Clear application cache
            </ButtonV2>
            <ButtonV2 variant="danger" icon="reset" onClick={resetLocalPreferences}>
              Restore default settings
            </ButtonV2>
          </div>
        </Card>
      </div>
    </Page>
  )

  const renderProfile = () => (
    <Page eyebrow="Profile" title="Your local identity" description="This profile is stored on this machine only.">
      <div class="settings-v2-section-grid">
        <Card icon="prompt" title="Profile card" description="Shown in local Vector surfaces when available.">
          <div class="settings-v2-profile-preview">
            <div class="settings-v2-avatar">
              <Show when={settings.profile.avatar()} fallback={<span>{avatarInitials()}</span>}>
                <img src={settings.profile.avatar()} alt="" />
              </Show>
            </div>
            <div>
              <strong>{settings.profile.displayName() || "Vector User"}</strong>
              <span>{settings.profile.bio() || "No bio saved yet."}</span>
            </div>
          </div>
          <div class="settings-v2-avatar-actions">
            <label class="settings-v2-pill-button">
              Upload avatar
              <input type="file" accept="image/*" onChange={onAvatarSelected} />
            </label>
            <ButtonV2 variant="outline" onClick={() => settings.profile.setAvatar("")}>
              Remove avatar
            </ButtonV2>
          </div>
          <TextRow
            title="Display name"
            value={settings.profile.displayName()}
            placeholder="Your name"
            onInput={settings.profile.setDisplayName}
          />
          <TextAreaRow
            title="Short bio"
            description="A short note for local workspace personalization."
            value={settings.profile.bio()}
            placeholder="Builder, student, founder, engineer..."
            onInput={settings.profile.setBio}
          />
        </Card>
      </div>
    </Page>
  )

  const renderAppearance = () => (
    <Page
      eyebrow="Appearance"
      title="Shape the workspace"
      description="Every visual choice below applies instantly and persists locally."
    >
      <div class="settings-v2-section-grid">
        <Card icon="photo" title="Theme and color" description="Set Vector's tone without external services.">
          <SelectRow
            title="Theme"
            options={themeOptions}
            value={settings.appearance.theme()}
            onChange={(value) => settings.appearance.setTheme(value as VectorThemePreference)}
          />
          <ColorRow
            title="Accent color"
            description="Used for focused controls, highlights, and Vector actions."
            value={settings.appearance.accentColor()}
            onInput={settings.appearance.setAccentColor}
          />
          <ColorRow title="Workspace color" value={settings.appearance.workspaceColor()} onInput={settings.appearance.setWorkspaceColor} />
          <ColorRow title="Sidebar color" value={settings.appearance.sidebarColor()} onInput={settings.appearance.setSidebarColor} />
          <ColorRow title="Chat color" value={settings.appearance.chatColor()} onInput={settings.appearance.setChatColor} />
          <div class="settings-v2-avatar-actions">
            <label class="settings-v2-pill-button">
              Custom chat backdrop
              <input type="file" accept="image/*" onChange={onBackdropSelected} />
            </label>
            <ButtonV2 variant="outline" onClick={() => settings.appearance.setChatBackdrop("")}>
              Use default backdrop
            </ButtonV2>
          </div>
        </Card>
        <Card icon="sliders" title="Layout feel" description="Tune density, motion, and rounding.">
          <RangeRow
            title="Interface font size"
            value={settings.appearance.fontSize()}
            min={12}
            max={20}
            format={(value) => `${value}px`}
            onInput={settings.appearance.setFontSize}
          />
          <SelectRow
            title="UI density"
            options={densityOptions}
            value={settings.appearance.density()}
            onChange={(value) => settings.appearance.setDensity(value as VectorDensityPreference)}
          />
          <ToggleRow
            title="Collapse sidebar by default"
            checked={settings.appearance.sidebarCollapsed()}
            onChange={settings.appearance.setSidebarCollapsed}
          />
          <ToggleRow
            title="Rounded corners"
            checked={settings.appearance.roundedCorners()}
            onChange={settings.appearance.setRoundedCorners}
          />
          <SelectRow
            title="Animation speed"
            options={animationOptions}
            value={settings.appearance.animationSpeed()}
            onChange={(value) => settings.appearance.setAnimationSpeed(value as VectorAnimationSpeedPreference)}
          />
          <ToggleRow
            title="Reduce motion"
            checked={settings.appearance.reduceAnimations()}
            onChange={settings.appearance.setReduceAnimations}
          />
          <ToggleRow
            title="Soft glass panels"
            description="Adds subtle transparency where the renderer supports it."
            checked={settings.appearance.glassmorphism()}
            onChange={settings.appearance.setGlassmorphism}
          />
        </Card>
        <Card icon="photo" title="Live preview" description="A small preview of your current workspace treatment." wide>
          <div class="settings-v2-preview-shell">
            <div class="settings-v2-preview-sidebar" />
            <div class="settings-v2-preview-main">
              <div class="settings-v2-preview-chip">Vector</div>
              <div class="settings-v2-preview-card">
                <span>What can I do for you?</span>
                <button type="button">Run</button>
              </div>
            </div>
          </div>
          <ButtonV2
            variant="outline"
            icon="reset"
            onClick={() => {
              settings.appearance.setAccentColor(defaultSettingsPreview.accent)
              settings.appearance.setWorkspaceColor(defaultSettingsPreview.workspace)
              settings.appearance.setSidebarColor(defaultSettingsPreview.sidebar)
              settings.appearance.setChatColor(defaultSettingsPreview.chat)
              settings.appearance.setChatBackdrop("")
            }}
          >
            Reset colors
          </ButtonV2>
        </Card>
      </div>
    </Page>
  )

  const renderPersonalization = () => (
    <Page
      eyebrow="Personalization"
      title="Teach Vector your taste"
      description="These local preferences guide prompts and defaults without leaving this device."
    >
      <div class="settings-v2-section-grid">
        <Card icon="brain" title="Stack preferences" description="Vector can bias plans toward your preferred stack.">
          <TextRow title="Preferred programming languages" value={settings.personalization.preferredLanguages()} onInput={settings.personalization.setPreferredLanguages} />
          <TextRow title="Frontend framework" value={settings.personalization.frontendFramework()} onInput={settings.personalization.setFrontendFramework} />
          <TextRow title="Backend framework" value={settings.personalization.backendFramework()} onInput={settings.personalization.setBackendFramework} />
          <TextRow title="Package manager" value={settings.personalization.packageManager()} placeholder="npm, pnpm, bun, pip..." onInput={settings.personalization.setPackageManager} />
          <TextRow title="Styling framework" value={settings.personalization.stylingFramework()} onInput={settings.personalization.setStylingFramework} />
          <TextRow title="Default project template" value={settings.personalization.defaultProjectTemplate()} onInput={settings.personalization.setDefaultProjectTemplate} />
        </Card>
        <Card icon="code" title="Code style" description="Control the shape of generated code.">
          <SelectRow title="Preferred indentation" options={indentationOptions} value={settings.personalization.indentation()} onChange={(value) => settings.personalization.setIndentation(value as VectorIndentationPreference)} />
          <NumberRow title="Tab width" value={settings.personalization.tabWidth()} min={2} max={8} onInput={settings.personalization.setTabWidth} />
          <SelectRow title="Preferred code style" options={codeStyleOptions} value={settings.personalization.codeStyle()} onChange={(value) => settings.personalization.setCodeStyle(value as VectorCodeStylePreference)} />
          <SelectRow title="Component naming" options={componentNamingOptions} value={settings.personalization.componentNaming()} onChange={(value) => settings.personalization.setComponentNaming(value as VectorComponentNamingPreference)} />
          <ToggleRow title="Always use TypeScript" checked={settings.personalization.alwaysTypeScript()} onChange={settings.personalization.setAlwaysTypeScript} />
          <ToggleRow title="Always use functional components" checked={settings.personalization.alwaysFunctionalComponents()} onChange={settings.personalization.setAlwaysFunctionalComponents} />
          <ToggleRow title="Always explain generated code" checked={settings.personalization.alwaysExplainCode()} onChange={settings.personalization.setAlwaysExplainCode} />
          <ToggleRow title="Always generate comments" checked={settings.personalization.alwaysGenerateComments()} onChange={settings.personalization.setAlwaysGenerateComments} />
        </Card>
        <Card icon="prompt" title="Custom user instructions" description="A local instruction layer for Vector's coding behavior." wide>
          <TextAreaRow
            title="Instructions"
            value={settings.personalization.customInstructions()}
            placeholder="Prefer small files, explain tradeoffs, keep CSS minimal..."
            onInput={settings.personalization.setCustomInstructions}
          />
        </Card>
      </div>
    </Page>
  )

  const renderShortcuts = () => (
    <Page eyebrow="Keyboard" title="Shortcuts" description="View and edit shortcuts supported by the current shortcut system.">
      <div class="settings-v2-section-grid">
        <Card icon="sliders" title="Command map" description="Includes new chat, search, settings, sidebar, send, project, and prompt focus." wide>
          <div class="settings-v2-shortcuts-embed">
            <SettingsKeybinds v2 />
          </div>
        </Card>
      </div>
    </Page>
  )

  const renderEditor = () => (
    <Page eyebrow="Editor" title="Code editor preferences" description="Local editor behavior for readable, calm coding sessions.">
      <div class="settings-v2-section-grid">
        <Card icon="code" title="Typography" description="Tune how code is displayed.">
          <RangeRow title="Font size" value={settings.editor.fontSize()} min={10} max={24} format={(value) => `${value}px`} onInput={settings.editor.setFontSize} />
          <SelectRow title="Font family" options={fontFamilyOptions} value={settings.editor.fontFamily()} onChange={settings.editor.setFontFamily} />
          <RangeRow title="Line height" value={settings.editor.lineHeight()} min={1.1} max={2.2} step={0.1} format={(value) => value.toFixed(1)} onInput={settings.editor.setLineHeight} />
        </Card>
        <Card icon="sliders" title="Editing behavior" description="Only local editor flags are shown here.">
          <ToggleRow title="Word wrap" checked={settings.editor.wordWrap()} onChange={settings.editor.setWordWrap} />
          <ToggleRow title="Show line numbers" checked={settings.editor.showLineNumbers()} onChange={settings.editor.setShowLineNumbers} />
          <ToggleRow title="Highlight active line" checked={settings.editor.highlightActiveLine()} onChange={settings.editor.setHighlightActiveLine} />
          <ToggleRow title="Render whitespace" checked={settings.editor.renderWhitespace()} onChange={settings.editor.setRenderWhitespace} />
          <ToggleRow title="Cursor animation" checked={settings.editor.cursorAnimation()} onChange={settings.editor.setCursorAnimation} />
          <SelectRow title="Cursor style" options={cursorStyleOptions} value={settings.editor.cursorStyle()} onChange={(value) => settings.editor.setCursorStyle(value as VectorCursorStylePreference)} />
          <ToggleRow title="Auto close brackets" checked={settings.editor.autoCloseBrackets()} onChange={settings.editor.setAutoCloseBrackets} />
          <ToggleRow title="Auto close quotes" checked={settings.editor.autoCloseQuotes()} onChange={settings.editor.setAutoCloseQuotes} />
          <ToggleRow title="Auto indent" checked={settings.editor.autoIndent()} onChange={settings.editor.setAutoIndent} />
          <ToggleRow title="Format on save" description="Uses only local formatting behavior when available." checked={settings.editor.formatOnSave()} onChange={settings.editor.setFormatOnSave} />
          <ToggleRow title="Smooth scrolling" checked={settings.editor.smoothScrolling()} onChange={settings.editor.setSmoothScrolling} />
        </Card>
      </div>
    </Page>
  )

  const renderChat = () => (
    <Page eyebrow="Chat" title="Conversation flow" description="Control how prompts are sent, titled, and displayed.">
      <div class="settings-v2-section-grid">
        <Card icon="bubble-5" title="Input behavior" description="Make the prompt box fit how you write.">
          <ToggleRow title="Enter to send" checked={settings.chat.enterToSend()} onChange={settings.chat.setEnterToSend} />
          <ToggleRow title="Shift+Enter for newline" checked={settings.chat.shiftEnterNewline()} onChange={settings.chat.setShiftEnterNewline} />
          <ToggleRow title="Auto-scroll conversations" checked={settings.chat.autoScroll()} onChange={settings.chat.setAutoScroll} />
          <ToggleRow title="Show timestamps" checked={settings.chat.showTimestamps()} onChange={settings.chat.setShowTimestamps} />
          <ToggleRow title="Show local token estimate" checked={settings.chat.showTokenEstimate()} onChange={settings.chat.setShowTokenEstimate} />
          <ToggleRow title="Generate conversation titles" checked={settings.chat.titleGeneration()} onChange={settings.chat.setTitleGeneration} />
          <ToggleRow title="Automatically rename conversations" checked={settings.chat.autoRenameConversations()} onChange={settings.chat.setAutoRenameConversations} />
        </Card>
        <Card icon="sliders" title="Conversation layout" description="Keep the chat canvas comfortable.">
          <SelectRow title="Chat width" options={chatWidthOptions} value={settings.chat.chatWidth()} onChange={(value) => settings.chat.setChatWidth(value as VectorChatWidthPreference)} />
          <SelectRow title="Message spacing" options={messageSpacingOptions} value={settings.chat.messageSpacing()} onChange={(value) => settings.chat.setMessageSpacing(value as VectorMessageSpacingPreference)} />
        </Card>
        <Card icon="brain" title="Explanations" description="How Vector explains plans, code, and reviews across Proof Pack, Learn Mode, and the other Vector tools.">
          <SelectRow
            title="Explanation style"
            description="Beginner defines every term and shows exact commands. Pro keeps it terse and expert-level."
            options={explanationStyleOptions}
            value={settings.chat.explanationStyle()}
            onChange={(value) => settings.chat.setExplanationStyle(value as VectorExplanationStylePreference)}
          />
        </Card>
      </div>
    </Page>
  )

  const renderNotifications = () => (
    <Page eyebrow="Notifications" title="Local alerts" description="Tune desktop notifications, sounds, and success motion.">
      <div class="settings-v2-section-grid">
        <Card icon="status" title="Signals" description="All options persist locally and use existing notification hooks.">
          <ToggleRow title="Enable notifications" checked={settings.notifications.agent()} onChange={settings.notifications.setAgent} />
          <ToggleRow title="Task completed notification" checked={settings.notifications.taskCompleted()} onChange={settings.notifications.setTaskCompleted} />
          <ToggleRow title="Error notifications" checked={settings.notifications.errors()} onChange={settings.notifications.setErrors} />
          <ToggleRow title="Sound effects" checked={settings.notifications.soundEffects()} onChange={settings.notifications.setSoundEffects} />
          <RangeRow title="Notification volume" value={settings.notifications.volume()} min={0} max={1} step={0.05} format={(value) => `${Math.round(value * 100)}%`} onInput={settings.notifications.setVolume} />
          <ToggleRow title="Success animations" checked={settings.notifications.successAnimations()} onChange={settings.notifications.setSuccessAnimations} />
        </Card>
      </div>
    </Page>
  )

  const renderAccessibility = () => (
    <Page eyebrow="Accessibility" title="Readable by default" description="Make Vector easier to navigate, see, and click.">
      <div class="settings-v2-section-grid">
        <Card icon="settings-gear" title="Display and motion" description="Accessibility preferences apply instantly.">
          <RangeRow title="UI scaling" value={settings.accessibility.uiScale()} min={0.85} max={1.35} step={0.05} format={(value) => `${Math.round(value * 100)}%`} onInput={settings.accessibility.setUIScale} />
          <ToggleRow title="High contrast mode" checked={settings.accessibility.highContrast()} onChange={settings.accessibility.setHighContrast} />
          <ToggleRow title="Reduced motion" checked={settings.appearance.reduceAnimations()} onChange={settings.appearance.setReduceAnimations} />
          <ToggleRow title="Keyboard navigation improvements" checked={settings.accessibility.keyboardNavigation()} onChange={settings.accessibility.setKeyboardNavigation} />
          <ToggleRow title="Visible focus indicators" checked={settings.accessibility.focusIndicators()} onChange={settings.accessibility.setFocusIndicators} />
          <ToggleRow title="Larger click targets" checked={settings.accessibility.largerClickTargets()} onChange={settings.accessibility.setLargerClickTargets} />
        </Card>
      </div>
    </Page>
  )

  const renderAbout = () => (
    <Page eyebrow="About" title="Vector desktop" description="Build and device information for this local app.">
      <div class="settings-v2-section-grid">
        <Card icon="help" title="Application" description="Current runtime and identity." wide>
          <div class="settings-v2-about-grid">
            <div class="settings-v2-about-logo">
              <img src="/vector-logo.png" alt="" />
            </div>
            <div class="settings-v2-about-item"><span>Version</span><strong>{platform.version || "Development"}</strong></div>
            <div class="settings-v2-about-item"><span>Platform</span><strong>{platform.platform}</strong></div>
            <div class="settings-v2-about-item"><span>Theme</span><strong>{settings.appearance.theme()}</strong></div>
            <div class="settings-v2-about-item"><span>Current model</span><strong>{currentModelLabel()}</strong></div>
            <div class="settings-v2-about-item"><span>Device</span><strong>{deviceInfo()}</strong></div>
            <div class="settings-v2-about-item"><span>License</span><strong>MIT — open source</strong></div>
          </div>
        </Card>
      </div>
    </Page>
  )

  const pages: Record<SettingsSection, () => JSX.Element> = {
    general: renderGeneral,
    profile: renderProfile,
    appearance: renderAppearance,
    personalization: renderPersonalization,
    shortcuts: renderShortcuts,
    editor: renderEditor,
    chat: renderChat,
    notifications: renderNotifications,
    accessibility: renderAccessibility,
    about: renderAbout,
  }

  return (
    <div class="settings-v2-content-root">
      <Show when={status()}>
        <div class="settings-v2-toast">{status()}</div>
      </Show>
      {pages[section()]()}
    </div>
  )
}
