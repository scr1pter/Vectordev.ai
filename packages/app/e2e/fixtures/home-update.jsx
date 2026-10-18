import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { HomeUpdate } from "../../src/components/home-update"
import { installUpdate, navigationUpdate, runningAgentCount } from "../../src/components/updater-action"
import { yieldLaunchScreen } from "../../src/features/launch/launch-bridge"
import "../../src/index.css"
import "../../src/vector-premium.css"

// Home's row of actions against a stand-in for the desktop's updater. The query picks ?updater= ready, installing,
// downloading, error or idle; ?agents= how many parallel agents are running (window.homeUpdateFixture.setRunning
// changes it); and ?fail=1 makes the install fail. What Home asks for is kept on window.homeUpdateFixture.calls.
const query = new URLSearchParams(location.search)
const version = "1.99.110"
const states = {
  ready: { status: "ready", version },
  installing: { status: "installing", version },
  downloading: { status: "downloading", version },
  error: { status: "error", message: "Vector could not reach the update server." },
  idle: { status: "idle" },
}
const [updaterState, setUpdaterState] = createSignal(states[query.get("updater") ?? "ready"] ?? states.idle)
const running = { agents: Number(query.get("agents") ?? 0) }
const fixture = {
  calls: [],
  set: (name) => setUpdaterState(states[name]),
  setRunning: (next) => Object.assign(running, next),
}
window.homeUpdateFixture = fixture

const updater = {
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

yieldLaunchScreen("app")
render(
  () => (
    <div data-vector-home style={{ padding: "24px" }}>
      <div class="vector-home-dashboard">
        <header data-vector-home-overview class="vector-home-heading">
          <div class="vector-home-heading__main">
            <div class="vector-home-heading__copy">
              <h1>Give Vector one concrete outcome.</h1>
            </div>
            <div class="vector-home-heading__actions">
              <button type="button" data-variant="primary">
                Start building
              </button>
              <button type="button" data-variant="secondary">
                Vector Cloud
              </button>
              <HomeUpdate
                update={navigationUpdate(updater.state())}
                onUpdate={() => void installUpdate(updater, (message) => fixture.calls.push(`failed: ${message}`))}
                runningAgents={async () => runningAgentCount({}, running.agents)}
              />
              <button type="button" data-variant="secondary" onClick={() => fixture.calls.push("settings")}>
                Settings
              </button>
            </div>
          </div>
        </header>
      </div>
    </div>
  ),
  document.querySelector("#root"),
)
