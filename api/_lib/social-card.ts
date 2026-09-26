import { createElement } from "react"
import { validSocialTitle } from "../../packages/web/src/lib/social-card.js"

export async function renderSocialCard(title: string) {
  if (!validSocialTitle(title)) throw new Error("Invalid social card title")
  const { ImageResponse } = await import("@vercel/og")
  const card = new ImageResponse(
    createElement(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0b0911",
          color: "#f5f2f8",
          padding: "64px 76px",
          fontFamily: "geist",
          borderLeft: "12px solid #aa8cff",
        },
      },
      createElement("div", { style: { display: "flex", fontSize: 30, color: "#c9b9ff", letterSpacing: 4 } }, "VECTOR"),
      createElement(
        "div",
        {
          style: { display: "flex", fontSize: title.length > 75 ? 54 : 68, lineHeight: 1.12, wordBreak: "break-all" },
        },
        title,
      ),
      createElement(
        "div",
        { style: { display: "flex", justifyContent: "space-between", fontSize: 23, color: "#a9a0b8" } },
        createElement("span", {}, "Documentation"),
        createElement("span", {}, "vectordev.ai"),
      ),
    ),
    { width: 1200, height: 630 },
  )
  const bytes = Buffer.from(await card.arrayBuffer())
  if (bytes.byteLength > 2_000_000) throw new Error("Social card response exceeds its limit")
  return bytes
}
