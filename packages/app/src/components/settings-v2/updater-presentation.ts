import type { UpdaterState } from "@/updater"

export function updaterPresentation(state: UpdaterState | undefined, currentVersion?: string) {
  const version = currentVersion || "Development"
  if (!state) {
    return {
      title: "Updates are managed by your deployment",
      description: `Vector ${version} is running in a browser. New versions arrive with the web deployment.`,
    }
  }

  if (state.status === "disabled") {
    return {
      title: "Updates unavailable in this build",
      description: `Vector ${version} is not connected to a release feed. Install a packaged production build to check for updates here.`,
    }
  }
  if (state.status === "checking") {
    return {
      title: "Checking for updates…",
      description: `Vector ${version} is contacting the production release feed.`,
    }
  }
  if (state.status === "downloading") {
    const progress = state.percent === undefined ? "" : ` ${Math.round(state.percent)}% complete.`
    return {
      title: `Downloading Vector ${state.version}`,
      description: `The update will be ready to restart shortly.${progress}`,
    }
  }
  if (state.status === "ready") {
    return {
      title: `Vector ${state.version} is ready`,
      description: "Restart Vector to finish installing the downloaded update.",
      action: "Restart to update",
    }
  }
  if (state.status === "installing") {
    return {
      title: `Installing Vector ${state.version}…`,
      description: "Vector will restart when installation finishes.",
    }
  }
  if (state.status === "up-to-date") {
    return {
      title: "Automatic updates are current",
      description: `No newer automatic update is available for Vector ${version}. Check Latest installers for manual-download releases.`,
      action: "Check again",
    }
  }
  if (state.status === "error") {
    return { title: "Update check failed", description: state.message, action: "Try again" }
  }
  return { title: "Software updates", description: `You are running Vector ${version}.`, action: "Check now" }
}
