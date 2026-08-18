import { createStore, reconcile } from "solid-js/store"
import { createEffect, createMemo } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { persisted } from "@/utils/persist"

export interface NotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
  soundEffects: boolean
}

export interface SoundSettings {
  agentEnabled: boolean
  agent: string
  permissionsEnabled: boolean
  permissions: string
  errorsEnabled: boolean
  errors: string
}

export type VectorElementPreference = "fire" | "space" | "earth" | "water" | "sky" | "lightning" | "crystal" | "shadow"
export type VectorWallpaperPreference = "nebula" | "void" | "grid" | "aurora"
export type VectorSidebarPreference = "fire" | "space" | "carbon" | "classic"
export type VectorFontPreference = "system" | "pixel" | "mono"

export type VectorDensityPreference = "comfortable" | "compact" | "spacious"
export type VectorThemePreference = "dark" | "light" | "system"
export type VectorLandingPreference = "home" | "last-project" | "new-chat"
export type VectorAnimationSpeedPreference = "off" | "calm" | "normal" | "fast"
export type VectorChatWidthPreference = "focused" | "wide" | "full"
export type VectorMessageSpacingPreference = "compact" | "comfortable" | "relaxed"

export interface Settings {
  general: {
    launchOnStartup: boolean
    reopenLastProject: boolean
    reopenPreviousChats: boolean
    autoSave: boolean
    confirmBeforeDeletingChats: boolean
    defaultLandingPage: VectorLandingPreference
    releaseNotes: boolean
    showFileTree: boolean
    showNavigation: boolean
    showSearch: boolean
    showStatus: boolean
    showTerminal: boolean
    showReasoningSummaries: boolean
    llmJudge: boolean
    autoModelRouting: boolean
    shellToolPartsExpanded: boolean
    editToolPartsExpanded: boolean
    showCustomAgents: boolean
    mobileTitlebarPosition: "top" | "bottom"
    newLayoutDesigns?: boolean
  }
  appearance: {
    theme: VectorThemePreference
    fontSize: number
    mono: string
    sans: string
    terminal: string
    element: VectorElementPreference
    wallpaper: VectorWallpaperPreference
    sidebar: VectorSidebarPreference
    fontPersonality: VectorFontPreference
    accentColor: string
    workspaceColor: string
    sidebarColor: string
    chatColor: string
    density: VectorDensityPreference
    sidebarCollapsed: boolean
    roundedCorners: boolean
    animationSpeed: VectorAnimationSpeedPreference
    reduceAnimations: boolean
    glassmorphism: boolean
  }
  editor: {
    fontSize: number
    fontFamily: string
    lineHeight: number
    wordWrap: boolean
    showLineNumbers: boolean
    highlightActiveLine: boolean
    renderWhitespace: boolean
    aiAutocomplete: boolean
  }
  chat: {
    chatWidth: VectorChatWidthPreference
    messageSpacing: VectorMessageSpacingPreference
  }
  keybinds: Record<string, string>
  permissions: {
    autoApprove: boolean
  }
  notifications: NotificationSettings
  sounds: SoundSettings
  accessibility: {
    uiScale: number
    highContrast: boolean
    focusIndicators: boolean
    largerClickTargets: boolean
  }
}

export const monoDefault = "System Mono"
export const sansDefault = "System Sans"
export const terminalDefault = "JetBrainsMono Nerd Font Mono"
export const newLayoutDesignsDefault = true

const monoFallback =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
const sansFallback = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const terminalFallback =
  '"JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const monoBase = monoFallback
const sansBase = sansFallback
const terminalBase = terminalFallback

function input(font: string | undefined) {
  return font ?? ""
}

function family(font: string) {
  if (/^[\w-]+$/.test(font)) return font
  return `"${font.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function stack(font: string | undefined, base: string) {
  const value = font?.trim() ?? ""
  if (!value) return base
  return `${family(value)}, ${base}`
}

export function monoInput(font: string | undefined) {
  return input(font)
}

export function sansInput(font: string | undefined) {
  return input(font)
}

export function monoFontFamily(font: string | undefined) {
  return stack(font, monoBase)
}

export function sansFontFamily(font: string | undefined) {
  return stack(font, sansBase)
}

export function terminalInput(font: string | undefined) {
  return input(font)
}

export function terminalFontFamily(font: string | undefined) {
  return stack(font, terminalBase)
}

const defaultSettings: Settings = {
  general: {
    launchOnStartup: false,
    reopenLastProject: true,
    reopenPreviousChats: true,
    autoSave: true,
    confirmBeforeDeletingChats: true,
    defaultLandingPage: "home",
    releaseNotes: true,
    showFileTree: true,
    showNavigation: false,
    showSearch: false,
    showStatus: false,
    showTerminal: false,
    showReasoningSummaries: false,
    llmJudge: false,
    // Off by default: this spends the user's own BYOK budget on a model they
    // did not choose, so it has to be something they opt into.
    autoModelRouting: false,
    shellToolPartsExpanded: false,
    editToolPartsExpanded: false,
    showCustomAgents: false,
    mobileTitlebarPosition: "top",
  },
  appearance: {
    theme: "dark",
    fontSize: 14,
    mono: "",
    sans: "",
    terminal: "",
    element: "space",
    wallpaper: "nebula",
    sidebar: "fire",
    fontPersonality: "system",
    accentColor: "#9b6cff",
    workspaceColor: "#1d1d1f",
    sidebarColor: "#242428",
    chatColor: "#202024",
    density: "comfortable",
    sidebarCollapsed: false,
    roundedCorners: true,
    animationSpeed: "normal",
    reduceAnimations: false,
    glassmorphism: true,
  },
  editor: {
    fontSize: 14,
    fontFamily: "",
    lineHeight: 1.6,
    wordWrap: true,
    showLineNumbers: true,
    highlightActiveLine: true,
    renderWhitespace: false,
    aiAutocomplete: true,
  },
  chat: {
    chatWidth: "focused",
    messageSpacing: "comfortable",
  },
  keybinds: {},
  permissions: {
    autoApprove: false,
  },
  notifications: {
    agent: true,
    permissions: true,
    errors: false,
    soundEffects: true,
  },
  sounds: {
    agentEnabled: true,
    agent: "staplebops-01",
    permissionsEnabled: true,
    permissions: "staplebops-02",
    errorsEnabled: true,
    errors: "nope-03",
  },
  accessibility: {
    uiScale: 1,
    highContrast: false,
    focusIndicators: true,
    largerClickTargets: false,
  },
}

function withFallback<T>(read: () => T | undefined, fallback: T) {
  return createMemo(() => read() ?? fallback)
}

export const { use: useSettings, provider: SettingsProvider } = createSimpleContext({
  name: "Settings",
  gate: false,
  init: () => {
    const [store, setStore, _, ready] = persisted("settings.v3", createStore<Settings>(defaultSettings))
    const showFileTree = withFallback(() => store.general?.showFileTree, defaultSettings.general.showFileTree)
    const showSearch = withFallback(() => store.general?.showSearch, defaultSettings.general.showSearch)
    const showStatus = withFallback(() => store.general?.showStatus, defaultSettings.general.showStatus)
    const showCustomAgents = withFallback(
      () => store.general?.showCustomAgents,
      defaultSettings.general.showCustomAgents,
    )
    const newLayoutDesigns = createMemo(() => true)
    const visible = (preference: () => boolean) => createMemo(() => !newLayoutDesigns() || preference())

    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      const themePreference = store.appearance?.theme ?? defaultSettings.appearance.theme
      const resolvedTheme =
        themePreference === "system"
          ? window.matchMedia?.("(prefers-color-scheme: light)").matches
            ? "light"
            : "dark"
          : themePreference
      const animationSpeed = store.appearance?.animationSpeed ?? defaultSettings.appearance.animationSpeed
      const animationDuration =
        animationSpeed === "off"
          ? "0ms"
          : animationSpeed === "calm"
            ? "280ms"
            : animationSpeed === "fast"
              ? "110ms"
              : "180ms"
      const rounded = store.appearance?.roundedCorners ?? defaultSettings.appearance.roundedCorners
      const density = store.appearance?.density ?? defaultSettings.appearance.density
      const uiScale = store.accessibility?.uiScale ?? defaultSettings.accessibility.uiScale
      const appearanceFontSize = store.appearance?.fontSize ?? defaultSettings.appearance.fontSize
      root.style.setProperty("--font-family-mono", monoFontFamily(store.appearance?.mono))
      root.style.setProperty("--font-family-sans", sansFontFamily(store.appearance?.sans))
      root.style.setProperty(
        "--vector-editor-font-size",
        `${store.editor?.fontSize ?? defaultSettings.editor.fontSize}px`,
      )
      root.style.setProperty(
        "--vector-editor-line-height",
        `${store.editor?.lineHeight ?? defaultSettings.editor.lineHeight}`,
      )
      const editorFont = store.editor?.fontFamily ?? defaultSettings.editor.fontFamily
      root.style.setProperty(
        "--vector-editor-font-family",
        `${editorFont ? `"${editorFont}", ` : ""}"JetBrainsMono Nerd Font Mono", "SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace`,
      )
      root.style.setProperty("--vector-ui-font-size", `${appearanceFontSize}px`)
      root.style.setProperty("--vector-ui-scale", `${uiScale}`)
      root.style.setProperty("--vector-ui-computed-font-size", `${appearanceFontSize * uiScale}px`)
      root.style.setProperty("--vector-radius-control", rounded ? "999px" : "12px")
      root.style.setProperty("--vector-radius-panel", rounded ? "26px" : "12px")
      root.style.setProperty("--vector-radius-card", rounded ? "18px" : "8px")
      root.style.setProperty("--vector-animation-duration", animationDuration)
      root.style.setProperty(
        "--vector-density-space",
        density === "compact" ? "0.78" : density === "spacious" ? "1.18" : "1",
      )
      root.dataset.vectorElement = store.appearance?.element ?? defaultSettings.appearance.element
      root.dataset.vectorWallpaper = store.appearance?.wallpaper ?? defaultSettings.appearance.wallpaper
      root.dataset.vectorBackdrop = store.appearance?.wallpaper ?? defaultSettings.appearance.wallpaper
      root.dataset.vectorSidebar = store.appearance?.sidebar ?? defaultSettings.appearance.sidebar
      root.dataset.vectorFontPersonality =
        store.appearance?.fontPersonality ?? defaultSettings.appearance.fontPersonality
      root.dataset.vectorFont = store.appearance?.fontPersonality ?? defaultSettings.appearance.fontPersonality
      root.dataset.vectorDensity = density
      root.dataset.colorScheme = resolvedTheme
      root.dataset.vectorTheme = resolvedTheme
      root.dataset.vectorThemePreference = themePreference
      root.style.setProperty("color-scheme", resolvedTheme)
      root.dataset.vectorRoundedCorners = store.appearance?.roundedCorners ? "true" : "false"
      root.dataset.vectorGlass = store.appearance?.glassmorphism ? "true" : "false"
      root.dataset.vectorAnimationSpeed = animationSpeed
      root.dataset.vectorReduceAnimations = store.appearance?.reduceAnimations ? "true" : "false"
      root.dataset.vectorHighContrast = store.accessibility?.highContrast ? "true" : "false"
      root.dataset.vectorFocusIndicators = store.accessibility?.focusIndicators ? "true" : "false"
      root.dataset.vectorLargerTargets = store.accessibility?.largerClickTargets ? "true" : "false"
      root.dataset.vectorEditorWordWrap = store.editor?.wordWrap ? "true" : "false"
      root.dataset.vectorEditorLineNumbers = store.editor?.showLineNumbers ? "true" : "false"
      root.dataset.vectorEditorActiveLine = store.editor?.highlightActiveLine ? "true" : "false"
      root.dataset.vectorEditorWhitespace = store.editor?.renderWhitespace ? "true" : "false"
      root.dataset.vectorChatWidth = store.chat?.chatWidth ?? defaultSettings.chat.chatWidth
      root.dataset.vectorMessageSpacing = store.chat?.messageSpacing ?? defaultSettings.chat.messageSpacing
      root.dataset.vectorSidebarCollapsed = store.appearance?.sidebarCollapsed ? "true" : "false"
      root.style.setProperty("--vector-chat-backdrop-image", 'url("/vector-space-backdrop.png")')
      root.style.setProperty("--vector-accent", store.appearance?.accentColor ?? defaultSettings.appearance.accentColor)
      root.style.setProperty(
        "--vector-workspace-bg",
        store.appearance?.workspaceColor ?? defaultSettings.appearance.workspaceColor,
      )
      root.style.setProperty(
        "--vector-sidebar-bg",
        store.appearance?.sidebarColor ?? defaultSettings.appearance.sidebarColor,
      )
      root.style.setProperty("--vector-chat-bg", store.appearance?.chatColor ?? defaultSettings.appearance.chatColor)
      root.style.setProperty("--vector-chat-width", store.chat?.chatWidth ?? defaultSettings.chat.chatWidth)
      root.style.setProperty(
        "--vector-message-spacing",
        store.chat?.messageSpacing ?? defaultSettings.chat.messageSpacing,
      )
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("vector.element", store.appearance?.element ?? defaultSettings.appearance.element)
      }
    })

    return {
      ready,
      get current() {
        return store
      },
      general: {
        launchOnStartup: withFallback(() => store.general?.launchOnStartup, defaultSettings.general.launchOnStartup),
        setLaunchOnStartup(value: boolean) {
          setStore("general", "launchOnStartup", value)
        },
        reopenLastProject: withFallback(
          () => store.general?.reopenLastProject,
          defaultSettings.general.reopenLastProject,
        ),
        setReopenLastProject(value: boolean) {
          setStore("general", "reopenLastProject", value)
        },
        reopenPreviousChats: withFallback(
          () => store.general?.reopenPreviousChats,
          defaultSettings.general.reopenPreviousChats,
        ),
        setReopenPreviousChats(value: boolean) {
          setStore("general", "reopenPreviousChats", value)
        },
        autoSave: withFallback(() => store.general?.autoSave, defaultSettings.general.autoSave),
        setAutoSave(value: boolean) {
          setStore("general", "autoSave", value)
        },
        confirmBeforeDeletingChats: withFallback(
          () => store.general?.confirmBeforeDeletingChats,
          defaultSettings.general.confirmBeforeDeletingChats,
        ),
        setConfirmBeforeDeletingChats(value: boolean) {
          setStore("general", "confirmBeforeDeletingChats", value)
        },
        defaultLandingPage: withFallback(
          () => store.general?.defaultLandingPage,
          defaultSettings.general.defaultLandingPage,
        ),
        setDefaultLandingPage(value: VectorLandingPreference) {
          setStore("general", "defaultLandingPage", value)
        },
        releaseNotes: withFallback(() => store.general?.releaseNotes, defaultSettings.general.releaseNotes),
        setReleaseNotes(value: boolean) {
          setStore("general", "releaseNotes", value)
        },
        showFileTree,
        setShowFileTree(value: boolean) {
          setStore("general", "showFileTree", value)
        },
        showNavigation: withFallback(() => store.general?.showNavigation, defaultSettings.general.showNavigation),
        setShowNavigation(value: boolean) {
          setStore("general", "showNavigation", value)
        },
        showSearch,
        setShowSearch(value: boolean) {
          setStore("general", "showSearch", value)
        },
        showStatus,
        setShowStatus(value: boolean) {
          setStore("general", "showStatus", value)
        },
        showTerminal: withFallback(() => store.general?.showTerminal, defaultSettings.general.showTerminal),
        setShowTerminal(value: boolean) {
          setStore("general", "showTerminal", value)
        },
        showReasoningSummaries: withFallback(
          () => store.general?.showReasoningSummaries,
          defaultSettings.general.showReasoningSummaries,
        ),
        setShowReasoningSummaries(value: boolean) {
          setStore("general", "showReasoningSummaries", value)
        },
        llmJudge: withFallback(() => store.general?.llmJudge, defaultSettings.general.llmJudge),
        autoModelRouting: withFallback(
          () => store.general?.autoModelRouting,
          defaultSettings.general.autoModelRouting,
        ),
        setLlmJudge(value: boolean) {
          setStore("general", "llmJudge", value)
        },
        setAutoModelRouting(value: boolean) {
          setStore("general", "autoModelRouting", value)
        },
        shellToolPartsExpanded: withFallback(
          () => store.general?.shellToolPartsExpanded,
          defaultSettings.general.shellToolPartsExpanded,
        ),
        setShellToolPartsExpanded(value: boolean) {
          setStore("general", "shellToolPartsExpanded", value)
        },
        editToolPartsExpanded: withFallback(
          () => store.general?.editToolPartsExpanded,
          defaultSettings.general.editToolPartsExpanded,
        ),
        setEditToolPartsExpanded(value: boolean) {
          setStore("general", "editToolPartsExpanded", value)
        },
        showCustomAgents,
        setShowCustomAgents(value: boolean) {
          setStore("general", "showCustomAgents", value)
        },
        mobileTitlebarPosition: withFallback(
          () => store.general?.mobileTitlebarPosition,
          defaultSettings.general.mobileTitlebarPosition,
        ),
        setMobileTitlebarPosition(value: "top" | "bottom") {
          setStore("general", "mobileTitlebarPosition", value)
        },
        newLayoutDesigns,
        setNewLayoutDesigns(value: boolean) {
          setStore("general", "newLayoutDesigns", true)
        },
      },
      visibility: {
        fileTree: visible(showFileTree),
        search: visible(showSearch),
        status: visible(showStatus),
        customAgents: visible(showCustomAgents),
      },
      appearance: {
        theme: withFallback(() => store.appearance?.theme, defaultSettings.appearance.theme),
        setTheme(value: VectorThemePreference) {
          setStore("appearance", "theme", value)
        },
        fontSize: withFallback(() => store.appearance?.fontSize, defaultSettings.appearance.fontSize),
        setFontSize(value: number) {
          setStore("appearance", "fontSize", value)
        },
        font: withFallback(() => store.appearance?.mono, defaultSettings.appearance.mono),
        setFont(value: string) {
          setStore("appearance", "mono", value.trim() ? value : "")
        },
        uiFont: withFallback(() => store.appearance?.sans, defaultSettings.appearance.sans),
        setUIFont(value: string) {
          setStore("appearance", "sans", value.trim() ? value : "")
        },
        terminalFont: withFallback(() => store.appearance?.terminal, defaultSettings.appearance.terminal),
        setTerminalFont(value: string) {
          setStore("appearance", "terminal", value.trim() ? value : "")
        },
        element: withFallback(() => store.appearance?.element, defaultSettings.appearance.element),
        setElement(value: VectorElementPreference) {
          setStore("appearance", "element", value)
        },
        wallpaper: withFallback(() => store.appearance?.wallpaper, defaultSettings.appearance.wallpaper),
        setWallpaper(value: VectorWallpaperPreference) {
          setStore("appearance", "wallpaper", value)
        },
        sidebar: withFallback(() => store.appearance?.sidebar, defaultSettings.appearance.sidebar),
        setSidebar(value: VectorSidebarPreference) {
          setStore("appearance", "sidebar", value)
        },
        fontPersonality: withFallback(
          () => store.appearance?.fontPersonality,
          defaultSettings.appearance.fontPersonality,
        ),
        setFontPersonality(value: VectorFontPreference) {
          setStore("appearance", "fontPersonality", value)
        },
        accentColor: withFallback(() => store.appearance?.accentColor, defaultSettings.appearance.accentColor),
        setAccentColor(value: string) {
          setStore("appearance", "accentColor", value)
        },
        workspaceColor: withFallback(() => store.appearance?.workspaceColor, defaultSettings.appearance.workspaceColor),
        setWorkspaceColor(value: string) {
          setStore("appearance", "workspaceColor", value)
        },
        sidebarColor: withFallback(() => store.appearance?.sidebarColor, defaultSettings.appearance.sidebarColor),
        setSidebarColor(value: string) {
          setStore("appearance", "sidebarColor", value)
        },
        chatColor: withFallback(() => store.appearance?.chatColor, defaultSettings.appearance.chatColor),
        setChatColor(value: string) {
          setStore("appearance", "chatColor", value)
        },
        density: withFallback(() => store.appearance?.density, defaultSettings.appearance.density),
        setDensity(value: VectorDensityPreference) {
          setStore("appearance", "density", value)
        },
        sidebarCollapsed: withFallback(
          () => store.appearance?.sidebarCollapsed,
          defaultSettings.appearance.sidebarCollapsed,
        ),
        setSidebarCollapsed(value: boolean) {
          setStore("appearance", "sidebarCollapsed", value)
        },
        roundedCorners: withFallback(() => store.appearance?.roundedCorners, defaultSettings.appearance.roundedCorners),
        setRoundedCorners(value: boolean) {
          setStore("appearance", "roundedCorners", value)
        },
        animationSpeed: withFallback(() => store.appearance?.animationSpeed, defaultSettings.appearance.animationSpeed),
        setAnimationSpeed(value: VectorAnimationSpeedPreference) {
          setStore("appearance", "animationSpeed", value)
        },
        reduceAnimations: withFallback(
          () => store.appearance?.reduceAnimations,
          defaultSettings.appearance.reduceAnimations,
        ),
        setReduceAnimations(value: boolean) {
          setStore("appearance", "reduceAnimations", value)
        },
        glassmorphism: withFallback(() => store.appearance?.glassmorphism, defaultSettings.appearance.glassmorphism),
        setGlassmorphism(value: boolean) {
          setStore("appearance", "glassmorphism", value)
        },
      },
      editor: {
        fontSize: withFallback(() => store.editor?.fontSize, defaultSettings.editor.fontSize),
        setFontSize(value: number) {
          setStore("editor", "fontSize", value)
        },
        fontFamily: withFallback(() => store.editor?.fontFamily, defaultSettings.editor.fontFamily),
        setFontFamily(value: string) {
          setStore("editor", "fontFamily", value)
        },
        lineHeight: withFallback(() => store.editor?.lineHeight, defaultSettings.editor.lineHeight),
        setLineHeight(value: number) {
          setStore("editor", "lineHeight", value)
        },
        wordWrap: withFallback(() => store.editor?.wordWrap, defaultSettings.editor.wordWrap),
        setWordWrap(value: boolean) {
          setStore("editor", "wordWrap", value)
        },
        showLineNumbers: withFallback(() => store.editor?.showLineNumbers, defaultSettings.editor.showLineNumbers),
        setShowLineNumbers(value: boolean) {
          setStore("editor", "showLineNumbers", value)
        },
        highlightActiveLine: withFallback(
          () => store.editor?.highlightActiveLine,
          defaultSettings.editor.highlightActiveLine,
        ),
        setHighlightActiveLine(value: boolean) {
          setStore("editor", "highlightActiveLine", value)
        },
        renderWhitespace: withFallback(() => store.editor?.renderWhitespace, defaultSettings.editor.renderWhitespace),
        setRenderWhitespace(value: boolean) {
          setStore("editor", "renderWhitespace", value)
        },
        aiAutocomplete: withFallback(() => store.editor?.aiAutocomplete, defaultSettings.editor.aiAutocomplete),
        setAiAutocomplete(value: boolean) {
          setStore("editor", "aiAutocomplete", value)
        },
      },
      chat: {
        chatWidth: withFallback(() => store.chat?.chatWidth, defaultSettings.chat.chatWidth),
        setChatWidth(value: VectorChatWidthPreference) {
          setStore("chat", "chatWidth", value)
        },
        messageSpacing: withFallback(() => store.chat?.messageSpacing, defaultSettings.chat.messageSpacing),
        setMessageSpacing(value: VectorMessageSpacingPreference) {
          setStore("chat", "messageSpacing", value)
        },
      },
      keybinds: {
        get: (action: string) => store.keybinds?.[action],
        set(action: string, keybind: string) {
          setStore("keybinds", action, keybind)
        },
        reset(action: string) {
          setStore("keybinds", (current) => {
            if (!Object.prototype.hasOwnProperty.call(current, action)) return current
            const next = { ...current }
            delete next[action]
            return next
          })
        },
        resetAll() {
          setStore("keybinds", reconcile({}))
        },
      },
      permissions: {
        autoApprove: withFallback(() => store.permissions?.autoApprove, defaultSettings.permissions.autoApprove),
        setAutoApprove(value: boolean) {
          setStore("permissions", "autoApprove", value)
        },
      },
      notifications: {
        agent: withFallback(() => store.notifications?.agent, defaultSettings.notifications.agent),
        setAgent(value: boolean) {
          setStore("notifications", "agent", value)
        },
        permissions: withFallback(() => store.notifications?.permissions, defaultSettings.notifications.permissions),
        setPermissions(value: boolean) {
          setStore("notifications", "permissions", value)
        },
        errors: withFallback(() => store.notifications?.errors, defaultSettings.notifications.errors),
        setErrors(value: boolean) {
          setStore("notifications", "errors", value)
        },
        soundEffects: withFallback(() => store.notifications?.soundEffects, defaultSettings.notifications.soundEffects),
        setSoundEffects(value: boolean) {
          setStore("notifications", "soundEffects", value)
        },
      },
      sounds: {
        // The master "Sound effects" switch (notifications.soundEffects) gates every
        // category below — flipping it off silences agent/permission/error sounds
        // without touching each category's own stored preference.
        agentEnabled: createMemo(
          () =>
            (store.sounds?.agentEnabled ?? defaultSettings.sounds.agentEnabled) &&
            (store.notifications?.soundEffects ?? defaultSettings.notifications.soundEffects),
        ),
        setAgentEnabled(value: boolean) {
          setStore("sounds", "agentEnabled", value)
        },
        agent: withFallback(() => store.sounds?.agent, defaultSettings.sounds.agent),
        setAgent(value: string) {
          setStore("sounds", "agent", value)
        },
        permissionsEnabled: createMemo(
          () =>
            (store.sounds?.permissionsEnabled ?? defaultSettings.sounds.permissionsEnabled) &&
            (store.notifications?.soundEffects ?? defaultSettings.notifications.soundEffects),
        ),
        setPermissionsEnabled(value: boolean) {
          setStore("sounds", "permissionsEnabled", value)
        },
        permissions: withFallback(() => store.sounds?.permissions, defaultSettings.sounds.permissions),
        setPermissions(value: string) {
          setStore("sounds", "permissions", value)
        },
        errorsEnabled: createMemo(
          () =>
            (store.sounds?.errorsEnabled ?? defaultSettings.sounds.errorsEnabled) &&
            (store.notifications?.soundEffects ?? defaultSettings.notifications.soundEffects),
        ),
        setErrorsEnabled(value: boolean) {
          setStore("sounds", "errorsEnabled", value)
        },
        errors: withFallback(() => store.sounds?.errors, defaultSettings.sounds.errors),
        setErrors(value: string) {
          setStore("sounds", "errors", value)
        },
      },
      accessibility: {
        uiScale: withFallback(() => store.accessibility?.uiScale, defaultSettings.accessibility.uiScale),
        setUIScale(value: number) {
          setStore("accessibility", "uiScale", value)
        },
        highContrast: withFallback(() => store.accessibility?.highContrast, defaultSettings.accessibility.highContrast),
        setHighContrast(value: boolean) {
          setStore("accessibility", "highContrast", value)
        },
        focusIndicators: withFallback(
          () => store.accessibility?.focusIndicators,
          defaultSettings.accessibility.focusIndicators,
        ),
        setFocusIndicators(value: boolean) {
          setStore("accessibility", "focusIndicators", value)
        },
        largerClickTargets: withFallback(
          () => store.accessibility?.largerClickTargets,
          defaultSettings.accessibility.largerClickTargets,
        ),
        setLargerClickTargets(value: boolean) {
          setStore("accessibility", "largerClickTargets", value)
        },
      },
      resetAll() {
        setStore(reconcile(defaultSettings))
      },
    }
  },
})
