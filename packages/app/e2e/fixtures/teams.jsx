import { render } from "solid-js/web"
import { TeamsPicker } from "../../src/components/settings-teams"
import { yieldLaunchScreen } from "../../src/features/launch/launch-bridge"
import "../../src/index.css"

yieldLaunchScreen("app")
render(
  () => (
    <div style={{ padding: "32px", "max-width": "700px" }}>
      <TeamsPicker
        load={async () => {
          const response = await fetch("/fixture/teams")
          if (!response.ok) throw new Error("Synthetic team-list error")
          return await response.json()
        }}
        select={async (team) => {
          const response = await fetch("/fixture/teams", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ orgID: team?.orgID ?? null }),
          })
          if (!response.ok) throw new Error("Synthetic team-switch error")
        }}
      />
    </div>
  ),
  document.querySelector("#root"),
)
