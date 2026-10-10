import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { argumentsFor, capture } from "./runner"

const root = join(import.meta.dir, "../local-audit/runner-self-test")
const cwd = join(root, "fixture")
await mkdir(cwd, { recursive: true })
const script = `
import { spawn } from "node:child_process";
if (process.cwd() !== process.env.PWD) process.exit(10);
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
console.log(JSON.stringify({childPid:child.pid}));
process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":3000,');
setTimeout(() => process.stdout.write('"cached_input_tokens":1000,"cache_write_input_tokens":500,"output_tokens":100}}\\n'), 30);
setInterval(() => {}, 1000);
`
const result = await capture({ command: process.execPath, args: ["-e", script], cwd, env: { PWD: "/wrong" }, timeoutMs: 1250, sampleMemory: true, logPrefix: join(root, "capture") })
if (!result.timedOut || result.exitCode !== 124) throw new Error("Expected timeout")
if (result.meter.tokens?.input !== 1500 || result.meter.tokens.cacheWrite !== 500) throw new Error("Fragmented JSON lost")
if (result.observedProcessCount < 2 || !result.sampledPeakProcessTreeRssKiB) throw new Error("Detached descendant not sampled")
const childPid = JSON.parse(result.stdoutText.split("\n")[0]!).childPid
const ps = Bun.spawn(["ps", "-p", String(childPid), "-o", "stat="], { stdout: "pipe", stderr: "ignore" })
const state = (await new Response(ps.stdout).text()).trim()
await ps.exited
if (state && !state.startsWith("Z")) throw new Error(`Detached descendant still alive: ${childPid} ${state}`)
const argv = argumentsFor("vector", { command: "vector", model: "openai/test" }, cwd, "test")
if (argv[argv.indexOf("--dir") + 1] !== cwd) throw new Error("Vector --dir missing")
const paired = argumentsFor("codex", { command: "bun", model: "openai/test", kind: "vector" }, cwd, "test")
if (paired[0] !== "run" || paired[paired.indexOf("--dir") + 1] !== cwd || paired.includes("exec")) throw new Error("Paired Vector launcher selected the wrong CLI dialect")
console.log("PASS: forced PWD, explicit Vector --dir, fragmented metering, detached descendant RSS and timeout cleanup")
