import { mkdir, rename } from "node:fs/promises"
import { join } from "node:path"

type Review = { status: "pending" | "reviewed"; findings: string[]; verdict?: string }
type Validation = {
  runtime: string; taskId: string; attempt: number; fixture: string; artifact: string;
  completedAt: string; officialOutcome: string; behaviorPass: boolean; typecheckPass: boolean | null;
  exitCode: number; stdoutPath: string; stderrPath: string; patchPath: string; patchSha256: string;
  codeQuality: Review;
}
type Result = {
  runtime: string; taskId: string; attempt: number; fixture: string; artifact: string;
  agent: { completedAt: string | null }; score: { outcome: string };
}
const report: { status: string; results: Result[]; metadata: { vectorCommit: string } } =
  await Bun.file(join(import.meta.dir, "runs/same-model-v2/report.json")).json()
if (report.metadata.vectorCommit !== "d3ae064a2f280d2c4e7231a1ad850d3c3b5d830c") throw new Error("Unexpected source ref")
const path = join(import.meta.dir, "validation.json")
const previous: { results: Validation[] } = await Bun.file(path).exists() ? await Bun.file(path).json() : { results: [] }
const results = previous.results
const fresh = report.results.filter((item) => item.agent.completedAt && !results.some((entry) =>
  entry.runtime === item.runtime && entry.taskId === item.taskId && entry.attempt === item.attempt))

for (const item of fresh) {
  const patchPath = join(item.artifact, "final.patch")
  if (!(await Bun.file(patchPath).exists()) || !(await Bun.file(join(item.artifact, "result.json")).exists())) continue
  const output = join(import.meta.dir, "validation-artifacts", item.taskId, String(item.attempt), item.runtime)
  await mkdir(output, { recursive: true })
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "validate-extra.ts"), item.fixture, item.taskId], {
    cwd: import.meta.dir, stdout: "pipe", stderr: "pipe",
  })
  const capture = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  const stdoutPath = join(output, "extra.stdout.log")
  const stderrPath = join(output, "extra.stderr.log")
  await Bun.write(stdoutPath, capture[1])
  await Bun.write(stderrPath, capture[2])
  const summary: { behaviorExitCode: number; sourceTypecheck: string } =
    JSON.parse(capture[1].trim().split("\n").at(-1) ?? "{}")
  const patchSha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(patchPath).arrayBuffer()).digest("hex")
  const duplicate = results.find((entry) => entry.patchSha256 === patchSha256 && entry.codeQuality.status === "reviewed")
  results.push({
    runtime: item.runtime, taskId: item.taskId, attempt: item.attempt, fixture: item.fixture, artifact: item.artifact,
    completedAt: new Date().toISOString(), officialOutcome: item.score.outcome,
    behaviorPass: summary.behaviorExitCode === 0,
    typecheckPass: summary.sourceTypecheck === "unavailable" ? null : summary.sourceTypecheck === "pass",
    exitCode: capture[0], stdoutPath, stderrPath, patchPath, patchSha256,
    codeQuality: duplicate?.codeQuality ?? { status: "pending", findings: [] },
  })
}
await Bun.write(`${path}.tmp`, JSON.stringify({
  expectedResults: 18, updatedAt: new Date().toISOString(), benchmarkStatus: report.status,
  vectorCommit: report.metadata.vectorCommit,
  frozenBehaviorSha256: "97fb9b306ba8f56c4654f54ff53477fa0059064966ed803adca447ba5c2456d2",
  frozenRunnerSha256: "5ca2abea5190caafdd77b16e86f3bd29ce8feab7780db704323de6cddcc4b955",
  method: "Frozen independent behavior tests run outside completed fixtures; source-only bun typecheck in disposable external package; manual review of final patches.",
  results,
}, null, 2) + "\n")
await rename(`${path}.tmp`, path)
console.log(JSON.stringify({
  officialResults: report.results.length, validated: results.length, benchmarkStatus: report.status,
  newResults: results.slice(-fresh.length || results.length).map((entry) => ({
    runtime: entry.runtime, taskId: entry.taskId, attempt: entry.attempt,
    behaviorPass: entry.behaviorPass, typecheckPass: entry.typecheckPass, patchPath: entry.patchPath,
  })),
  pendingReview: results.filter((entry) => entry.codeQuality.status === "pending").map((entry) => ({
    runtime: entry.runtime, taskId: entry.taskId, attempt: entry.attempt, patchSha256: entry.patchSha256, patchPath: entry.patchPath,
  })),
}))
