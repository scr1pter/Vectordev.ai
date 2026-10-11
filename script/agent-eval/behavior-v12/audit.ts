import { join } from "node:path"
import { inspectConsumption } from "./source-consumption"
import { loadShellState } from "./shell-state"
import { episodeStop } from "./episode-stop"

const output = process.argv[2]
const episode = (await Bun.file(join(output, "episodes.json")).json())[0]
const attempts = await Bun.file(join(output, "transport-attempts.json")).json()
const settlements = (await Bun.file(join(output, "settlements.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line))
const shell = loadShellState(output, episode.history[0].info.path?.cwd ?? (await Bun.file(join(output, "cases.json")).json())[0].directory, episode.sessionID)
if (!shell.passed || episode.shellFailure || episode.childrenAfter.length) throw new Error("SHELL_OR_CHILD_BOUNDARY_FAILED")
const consumption = inspectConsumption(attempts, episode, settlements)
const result = { passed: true, shell, consumption, stop: episodeStop(episode), attempts: attempts.length, shape: attempts[0]?.shape, synthetic: attempts.every((item: { synthetic: boolean }) => item.synthetic) }
await Bun.write(join(output, "audit.json"), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
