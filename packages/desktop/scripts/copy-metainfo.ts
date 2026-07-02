import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "ai.vector.desktop" : `ai.vector.desktop.${channel}`
const productName = channel === "prod" ? "Vector" : `Vector ${channel.charAt(0).toUpperCase() + channel.slice(1)}`
const summary = `Free BYOK AI coding workspace${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="ly.anoma">
    <name>Vector</name>
  </developer>

  <description>
    <p>
      Vector is a BYOK AI coding workspace that helps you write and run code with any AI model.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://github.com/scr1pter/Vectordev.ai/issues</url>
  <url type="homepage">https://vectordev.ai</url>
  <url type="vcs-browser">https://github.com/scr1pter/Vectordev.ai</url>

  <screenshots>
    <screenshot type="default">
      <image>https://vectordev.ai/og.png</image>
    </screenshot>
  </screenshots>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
