import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { PlatformProvider } from "../../src/context/platform"
import { WorkspaceNavigation } from "../../src/components/workspace-navigation"
import { installUpdate, navigationUpdate } from "../../src/components/updater-action"
import { yieldLaunchScreen } from "../../src/features/launch/launch-bridge"
import "../../src/index.css"
import "../../src/vector-premium.css"

// The sidebar against stand-ins for the desktop's updater and account bridges. The query picks ?updater= ready,
// installing, downloading, checking, error, disabled, idle, up-to-date, or none (the web build, with no updater);
// ?account= signed-in, signed-out, pending or none (no account bridge); ?agents= how many agents in the workspace are
// running; and ?fail=1 makes the install fail. What the sidebar asks for is kept on window.navigationFixture.calls.
const query = new URLSearchParams(location.search)
const version = "1.99.110"
const states = {
  ready: { status: "ready", version },
  installing: { status: "installing", version },
  downloading: { status: "downloading", version },
  checking: { status: "checking" },
  error: { status: "error", message: "Vector could not reach the update server." },
  disabled: { status: "disabled" },
  idle: { status: "idle" },
  "up-to-date": { status: "up-to-date" },
}
const kind = query.get("updater") ?? "ready"
const [updaterState, setUpdaterState] = createSignal(states[kind] ?? states.idle)
const fixture = { calls: [], set: (name) => setUpdaterState(states[name]) }
window.navigationFixture = fixture

const accounts = {
  "signed-in": { authenticated: true, pending: false, name: "Ana Diaz", email: "ana@example.com" },
  "signed-out": { authenticated: false, pending: false },
  pending: { authenticated: false, pending: true },
}
const account = accounts[query.get("account") ?? "signed-in"]

const updater =
  kind === "none"
    ? undefined
    : {
        state: updaterState,
        check: async () => updaterState(),
        install: async () => {
          fixture.calls.push("install")
          if (query.get("fail")) {
            setUpdaterState({ status: "error", message: "Vector could not install the update." })
            throw new Error("updater-install: failed")
          }
          setUpdaterState({ status: "installing", version })
        },
      }

const platform = {
  platform: kind === "none" ? "web" : "desktop",
  version: "1.99.109",
  openLink: () => undefined,
  restart: async () => undefined,
  back: () => undefined,
  forward: () => undefined,
  notify: async () => undefined,
  updater,
  vectorAccount: account && {
    status: async () => account,
    start: async () => {
      fixture.calls.push("sign-in")
      return account
    },
    cancel: async () => account,
    logout: async () => account,
    onChange: () => () => undefined,
  },
}

const noop = () => undefined
yieldLaunchScreen("app")
render(
  () => (
    <PlatformProvider value={platform}>
      <WorkspaceNavigation
        width={280}
        minimumWidth={220}
        maximumWidth={420}
        macDesktop={false}
        visible
        resizing={false}
        projectName="vector"
        mainLabel="Vector"
        mainActive
        treeOpen
        items={[]}
        currentVersion="1.99.109"
        settingsKeybind="⌘,"
        update={navigationUpdate(platform.updater?.state())}
        onUpdate={() => void installUpdate(platform.updater, (message) => fixture.calls.push(`failed: ${message}`))}
        runningAgents={Number(query.get("agents") ?? 0)}
        onSettings={() => fixture.calls.push("settings")}
        onAccount={() => fixture.calls.push("account")}
        onResizeStart={noop}
        onResize={noop}
        onResetWidth={noop}
        onHome={noop}
        onHide={noop}
        onToggleTree={noop}
        onNewWorkspace={noop}
        onOpenMain={noop}
        onOpenWorkspace={noop}
        onReviewWorkspace={noop}
        onRemoveWorkspace={noop}
        onMoveWorkspace={noop}
        onCodeEditor={noop}
        onAgentDashboard={noop}
        onPullRequests={noop}
        onBrowser={noop}
        onMcp={noop}
        onPlugins={noop}
        onFind={noop}
        onReportBug={noop}
        onGettingStarted={noop}
      />
    </PlatformProvider>
  ),
  document.querySelector("#root"),
)
