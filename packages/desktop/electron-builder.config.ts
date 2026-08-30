import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
const desktopEntry = path.join(packageDir, "resources", "linux", "vector-desktop.desktop")
const desktopEntryFpm = `${desktopEntry}=/usr/share/applications/vector-desktop.desktop`
const signMac = process.env.VECTOR_SIGN_MAC === "true"
const notarizeMac = process.env.VECTOR_NOTARIZE === "true"
const signDmg = process.env.VECTOR_SIGN_DMG === "true"
const allowUnsignedRelease = process.env.VECTOR_ALLOW_UNSIGNED_RELEASE === "true"
const windowsPublisherName = process.env.VECTOR_WINDOWS_PUBLISHER_NAME?.trim()
const updateBaseUrl = "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases"
const releaseElectronFuses = {
  // The server sidecar uses utilityProcess.fork, so packaged releases do not
  // depend on Electron's Node-compatible executable mode.
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false,
} satisfies NonNullable<Configuration["electronFuses"]>

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

if (process.env.GITHUB_ACTIONS === "true" && channel === "prod" && !allowUnsignedRelease) {
  if (process.platform === "darwin" && (!signMac || !notarizeMac || !signDmg)) {
    throw new Error("Production macOS artifacts must be signed and notarized.")
  }
  if (process.platform === "win32" && !windowsPublisherName) {
    throw new Error("Production Windows artifacts require VECTOR_WINDOWS_PUBLISHER_NAME.")
  }
}

const APP_IDS = {
  dev: "ai.vector.app.dev",
  beta: "ai.vector.app.beta",
  prod: "ai.vector.app",
} as const

const EXECUTABLE_NAMES = {
  dev: "vector-desktop-dev",
  beta: "vector-desktop-beta",
  prod: "vector-desktop",
} as const

const getBase = (appId: string, executableName: string): Configuration => ({
  // Updater artifacts are immutable by version. Publishing latest*.yml last can
  // then switch clients to a complete new set without invalidating the files
  // referenced by the previous release metadata.
  artifactName: "vector-desktop-${version}-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.vector.app" becomes
  // "ai.vector.app.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    name: "vector-desktop",
    desktopName: `${appId}.desktop`,
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      // Written by the same build invocation that compiles CHANNEL into the
      // main process. Package verification compares this marker with the
      // bundle id and feed, preventing stale dev output from becoming a
      // production-looking app with its updater silently disabled.
      from: `out/vector-build.json`,
      to: `vector-build.json`,
    },
    {
      from: "resources/icons/",
      to: "icons/",
      filter: ["**/*"],
    },
    {
      from: path.join(rootDir, "LICENSE"),
      to: "LICENSE.txt",
    },
    {
      from: path.join(rootDir, "THIRD_PARTY_NOTICES.md"),
      to: "THIRD_PARTY_NOTICES.md",
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    extendInfo: {
      NSMicrophoneUsageDescription:
        "Vector uses microphone access only when you start voice dictation or a voice-enabled agent session.",
    },
    hardenedRuntime: true,
    identity: signMac ? undefined : "-",
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: notarizeMac,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: signDmg,
  },
  protocols: {
    name: "Vector",
    schemes: ["vector"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signExecutable: !allowUnsignedRelease,
    signtoolOptions: allowUnsignedRelease
      ? undefined
      : {
          publisherName: windowsPublisherName ? [windowsPublisherName] : undefined,
          sign: signWindows,
          signingHashAlgorithms: ["sha256"],
        },
    target: ["nsis"],
    verifyUpdateCodeSignature: !allowUnsignedRelease,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    // @electron/fuses treats any path containing ".app" as a macOS bundle.
    // Keep the Linux binary distinct from the reverse-DNS application ID.
    executableName,
    syncDesktopName: true,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId, EXECUTABLE_NAMES[channel])

  if (channel === "dev") {
    return {
      ...base,
      appId,
      productName: "Vector Dev",
      rpm: { packageName: "vector-dev" },
    }
  }
  if (channel === "beta") {
    return {
      ...base,
      appId,
      productName: "Vector Beta",
      protocols: { name: "Vector Beta", schemes: ["vector"] },
      publish: { provider: "generic", url: `${updateBaseUrl}/vector-beta-updates` },
      rpm: { packageName: "vector-beta" },
      electronFuses: releaseElectronFuses,
    }
  }
  return {
    ...base,
    appId,
    productName: "Vector",
    protocols: { name: "Vector", schemes: ["vector"] },
    publish: { provider: "generic", url: `${updateBaseUrl}/vector-updates` },
    deb: { fpm: [desktopEntryFpm] },
    rpm: { packageName: "vector", fpm: [desktopEntryFpm] },
    electronFuses: releaseElectronFuses,
  }
}

export default getConfig()
