import { expect, test } from "bun:test"
import { capture } from "./capture"

test("meters fragmented JSON and UTF-8 stdout including the final unterminated event", async () => {
  const result = await capture({
    command: process.execPath,
    args: [
      "-e",
      `
      const lines = Buffer.from(JSON.stringify({type:"step_finish", part:{cost:0.25,tokens:{input:9,output:2,cache:{read:0,write:0}},text:"🙂"}})+"\\n"+JSON.stringify({type:"tool_use",part:{callID:"one"}}));
      for (let i=0;i<lines.length;i++) { process.stdout.write(lines.subarray(i,i+1)); await Bun.sleep(1) }
      process.stderr.write(JSON.stringify({type:"step_finish",part:{cost:999,tokens:{input:999}}}));
    `,
    ],
    cwd: import.meta.dir,
    timeoutMs: 10_000,
  })
  expect(result.exitCode).toBe(0)
  expect(result.output).toContain("🙂")
  expect(result.meter.costUsd).toBe(0.25)
  expect(result.meter.tokens?.input).toBe(9)
  expect(result.toolCalls).toBe(1)
})

test("flags runtime failure even when the process exits successfully", async () => {
  const result = await capture({
    command: process.execPath,
    args: ["-e", 'console.log(JSON.stringify({type:"turn.failed",error:{message:"Provider failed"}}))'],
    cwd: import.meta.dir,
    timeoutMs: 5_000,
  })
  expect(result.exitCode).toBe(0)
  expect(result.runtimeError).toBe(true)
  expect(result.completed).toBe(false)
})

test("recognizes terminal completion and ignores malformed tool events", async () => {
  const result = await capture({
    command: process.execPath,
    args: [
      "-e",
      `
      for (const event of [null, [], {type:"assistant",message:{content:{bad:true}}}, {type:"assistant",message:{content:[null, 3]}}, {type:"step_finish",subagent:true,part:{reason:"stop"}}, {type:"turn.completed",usage:{input_tokens:9,output_tokens:1}}]) console.log(JSON.stringify(event));
    `,
    ],
    cwd: import.meta.dir,
    timeoutMs: 5_000,
  })
  expect(result.exitCode).toBe(0)
  expect(result.completed).toBe(true)
  expect(result.toolCalls).toBe(0)
  expect(result.meter.tokens?.input).toBe(9)
})

test("times out the process and reports missing executables distinctly", async () => {
  const timed = await capture({
    command: process.execPath,
    args: ["-e", "await Bun.sleep(10000)"],
    cwd: import.meta.dir,
    timeoutMs: 50,
  })
  expect(timed.exitCode).toBe(124)
  expect(timed.timedOut).toBe(true)
  const missing = await capture({
    command: "vector-eval-command-does-not-exist",
    args: [],
    cwd: import.meta.dir,
    timeoutMs: 5_000,
  })
  expect(missing.exitCode).toBe(127)
  expect(missing.timedOut).toBe(false)
})
