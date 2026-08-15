import { Component, JSX, Show, createSignal } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import {
  type VectorChatWidthPreference,
  type VectorMessageSpacingPreference,
  useSettings,
} from "@/context/settings"
import "./settings-v2.css"

export type SettingsSection = "general" | "appearance" | "editor" | "chat" | "notifications" | "accessibility"

type Option = {
  value: string
  label: string
}

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

const fontFamilyOptions: Option[] = [
  { value: "", label: "System mono" },
  { value: "JetBrains Mono", label: "JetBrains Mono" },
  { value: "SF Mono", label: "SF Mono" },
  { value: "Fira Code", label: "Fira Code" },
  { value: "Geist Mono", label: "Geist Mono" },
]

const defaultSettingsPreview = {
  accent: "#9b6cff",
  workspace: "#1d1d1f",
  sidebar: "#242428",
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
  const settings = useSettings()
  const [status, setStatus] = createSignal("")
  let statusTimeout: ReturnType<typeof setTimeout> | undefined

  const section = () => props.section ?? "general"
  const announce = (message: string) => {
    if (statusTimeout !== undefined) clearTimeout(statusTimeout)
    setStatus(message)
    statusTimeout = setTimeout(() => setStatus(""), 2400)
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

  const renderGeneral = () => (
    <Page
      eyebrow="General"
      title="Local application data"
      description="Manage the preferences and temporary data Vector stores on this device."
    >
      <div class="settings-v2-section-grid">
        <Card
          icon="reset"
          title="Local data"
          description="Preferences and caches stored on this device. Project files are never touched."
        >
          <div class="settings-v2-action-grid">
            <ButtonV2 variant="outline" icon="trash" onClick={clearApplicationCache}>
              Clear application cache
            </ButtonV2>
            <ButtonV2 variant="danger" icon="reset" onClick={resetLocalPreferences}>
              Restore default settings
            </ButtonV2>
          </div>
        </Card>
        <Card
          icon="circle-check"
          title="Verified completion"
          description="Control whether Vector independently tests and scores engineering work before calling it complete."
        >
          <ToggleRow
            title="LLM-as-a-judge"
            description="After implementation, a separate judge agent checks the request, diff, tests, runtime evidence, and regression risk. Failed verdicts trigger a bounded repair-and-retest loop. This uses additional model calls and tokens."
            checked={settings.general.llmJudge()}
            onChange={settings.general.setLlmJudge}
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
        <Card icon="photo" title="Workspace colors" description="Set Vector's tone without external services.">
          <ColorRow
            title="Accent color"
            description="Used for focused controls, highlights, and Vector actions."
            value={settings.appearance.accentColor()}
            onInput={settings.appearance.setAccentColor}
          />
          <ColorRow
            title="Workspace color"
            value={settings.appearance.workspaceColor()}
            onInput={settings.appearance.setWorkspaceColor}
          />
          <ColorRow
            title="Sidebar color"
            value={settings.appearance.sidebarColor()}
            onInput={settings.appearance.setSidebarColor}
          />
          <ColorRow
            title="Chat color"
            value={settings.appearance.chatColor()}
            onInput={settings.appearance.setChatColor}
          />
          <ButtonV2
            variant="outline"
            icon="reset"
            onClick={() => {
              settings.appearance.setAccentColor(defaultSettingsPreview.accent)
              settings.appearance.setWorkspaceColor(defaultSettingsPreview.workspace)
              settings.appearance.setSidebarColor(defaultSettingsPreview.sidebar)
              settings.appearance.setChatColor(defaultSettingsPreview.chat)
            }}
          >
            Restore default colors
          </ButtonV2>
        </Card>
        <Card icon="sliders" title="Layout feel" description="Tune sizing, motion, and rounding.">
          <RangeRow
            title="Interface font size"
            value={settings.appearance.fontSize()}
            min={12}
            max={20}
            format={(value) => `${value}px`}
            onInput={settings.appearance.setFontSize}
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
      </div>
    </Page>
  )

  const renderEditor = () => (
    <Page
      eyebrow="Editor"
      title="Code editor preferences"
      description="Local editor behavior for readable, calm coding sessions."
    >
      <div class="settings-v2-section-grid">
        <Card icon="code" title="Typography" description="Tune how code is displayed.">
          <RangeRow
            title="Font size"
            value={settings.editor.fontSize()}
            min={10}
            max={24}
            format={(value) => `${value}px`}
            onInput={settings.editor.setFontSize}
          />
          <SelectRow
            title="Font family"
            options={fontFamilyOptions}
            value={settings.editor.fontFamily()}
            onChange={settings.editor.setFontFamily}
          />
          <RangeRow
            title="Line height"
            value={settings.editor.lineHeight()}
            min={1.1}
            max={2.2}
            step={0.1}
            format={(value) => value.toFixed(1)}
            onInput={settings.editor.setLineHeight}
          />
        </Card>
        <Card
          icon="sliders"
          title="Editing behavior"
          description="Local editor flags, applied to the file editor live."
        >
          <ToggleRow title="Word wrap" checked={settings.editor.wordWrap()} onChange={settings.editor.setWordWrap} />
          <ToggleRow
            title="Show line numbers"
            checked={settings.editor.showLineNumbers()}
            onChange={settings.editor.setShowLineNumbers}
          />
          <ToggleRow
            title="Highlight active line"
            checked={settings.editor.highlightActiveLine()}
            onChange={settings.editor.setHighlightActiveLine}
          />
          <ToggleRow
            title="Render whitespace"
            checked={settings.editor.renderWhitespace()}
            onChange={settings.editor.setRenderWhitespace}
          />
          <ToggleRow
            title="AI autocomplete"
            description="Cursor-style ghost-text suggestions as you type in the editor. Tab to accept."
            checked={settings.editor.aiAutocomplete()}
            onChange={settings.editor.setAiAutocomplete}
          />
        </Card>
      </div>
    </Page>
  )

  const renderChat = () => (
    <Page eyebrow="Chat" title="Conversation flow" description="Control how the conversation canvas is laid out.">
      <div class="settings-v2-section-grid">
        <Card icon="sliders" title="Conversation layout" description="Keep the chat canvas comfortable.">
          <SelectRow
            title="Chat width"
            options={chatWidthOptions}
            value={settings.chat.chatWidth()}
            onChange={(value) => settings.chat.setChatWidth(value as VectorChatWidthPreference)}
          />
          <SelectRow
            title="Message spacing"
            options={messageSpacingOptions}
            value={settings.chat.messageSpacing()}
            onChange={(value) => settings.chat.setMessageSpacing(value as VectorMessageSpacingPreference)}
          />
        </Card>
      </div>
    </Page>
  )

  const renderNotifications = () => (
    <Page eyebrow="Notifications" title="Local alerts" description="Tune desktop notifications and sounds.">
      <div class="settings-v2-section-grid">
        <Card
          icon="status"
          title="Signals"
          description="All options persist locally and use existing notification hooks."
        >
          <ToggleRow
            title="Enable notifications"
            description="Desktop notification when the agent finishes or needs input."
            checked={settings.notifications.agent()}
            onChange={settings.notifications.setAgent}
          />
          <ToggleRow
            title="Error notifications"
            checked={settings.notifications.errors()}
            onChange={settings.notifications.setErrors}
          />
          <ToggleRow
            title="Sound effects"
            description="Master switch for agent, permission, and error sounds."
            checked={settings.notifications.soundEffects()}
            onChange={settings.notifications.setSoundEffects}
          />
        </Card>
      </div>
    </Page>
  )

  const renderAccessibility = () => (
    <Page
      eyebrow="Accessibility"
      title="Readable by default"
      description="Make Vector easier to navigate, see, and click."
    >
      <div class="settings-v2-section-grid">
        <Card icon="settings-gear" title="Display and motion" description="Accessibility preferences apply instantly.">
          <RangeRow
            title="UI scaling"
            value={settings.accessibility.uiScale()}
            min={0.85}
            max={1.35}
            step={0.05}
            format={(value) => `${Math.round(value * 100)}%`}
            onInput={settings.accessibility.setUIScale}
          />
          <ToggleRow
            title="High contrast mode"
            checked={settings.accessibility.highContrast()}
            onChange={settings.accessibility.setHighContrast}
          />
          <ToggleRow
            title="Reduced motion"
            checked={settings.appearance.reduceAnimations()}
            onChange={settings.appearance.setReduceAnimations}
          />
          <ToggleRow
            title="Visible focus indicators"
            checked={settings.accessibility.focusIndicators()}
            onChange={settings.accessibility.setFocusIndicators}
          />
          <ToggleRow
            title="Larger click targets"
            checked={settings.accessibility.largerClickTargets()}
            onChange={settings.accessibility.setLargerClickTargets}
          />
        </Card>
      </div>
    </Page>
  )

  const pages: Record<SettingsSection, () => JSX.Element> = {
    general: renderGeneral,
    appearance: renderAppearance,
    editor: renderEditor,
    chat: renderChat,
    notifications: renderNotifications,
    accessibility: renderAccessibility,
  }

  return (
    <div class="settings-v2-content-root">
      <Show when={status()}>
        <div class="settings-v2-toast" role="status" aria-live="polite">
          {status()}
        </div>
      </Show>
      {pages[section()]()}
    </div>
  )
}
