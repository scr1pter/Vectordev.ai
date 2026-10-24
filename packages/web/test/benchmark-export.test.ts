import { expect, test } from "bun:test"
import { resolve } from "node:path"

test("benchmark exports exclude external-agent records and reports containing their aggregate measurements", async () => {
  const script = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('metric_export', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "reports = json.load(sys.stdin)",
    "print(json.dumps([module.project(report) is module.OMIT for report in reports]))",
  ].join("\n")
  const child = Bun.spawn(
    [
      process.platform === "win32" ? "python" : "python3",
      "-c",
      script,
      resolve(import.meta.dir, "../../../docs/benchmarks/vector-codex-2026-10/export.py"),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  child.stdin.write(
    JSON.stringify([
      { runtime: "vector", totalTokens: 10 },
      { runtime: "codex", totalTokens: 20 },
      { runtime: "claude-code", totalTokens: 30 },
      { runtime: "vector", excludedFromLearning: true, totalTokens: 40 },
      {
        totalTokens: 30,
        trials: [
          { runtime: "vector", totalTokens: 10 },
          { runtime: "retired-agent", totalTokens: 20 },
        ],
      },
    ]),
  )
  child.stdin.end()
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(stdout)).toEqual([false, true, true, true, true])
})
