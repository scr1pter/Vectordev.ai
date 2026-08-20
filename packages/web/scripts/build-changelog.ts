// Emits public/changelog.json, the feed the desktop app polls on launch to show
// "what's new". The file has never existed, so the release-notes dialog has
// never once run. Generated from the same release series the site renders, so
// the two cannot drift apart.
import { release117, release118, release119, releaseSeries } from "../src/data/vector-releases"

// Both arrays: releaseSeries is the 1.0-1.17 arc, release117 the 1.17.x
// point releases the desktop app actually ships as.
const releases = [...releaseSeries, ...release117, ...release118, ...release119].reverse().map((release) => ({
  tag: `v${release.version}`,
  highlights: [
    {
      // The reader keeps only highlight groups whose source mentions "desktop".
      source: "desktop",
      items: [{ title: release.title, description: release.summary }],
    },
  ],
}))

await Bun.write(`${import.meta.dir}/../public/changelog.json`, JSON.stringify({ releases }, null, 2))
console.log(`changelog.json: ${releases.length} releases, newest ${releases[0]?.tag}`)
