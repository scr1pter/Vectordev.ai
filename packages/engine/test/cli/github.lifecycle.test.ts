import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("Actions SIGTERM awaits credential finalizers before the process can exit", async () => {
  await using fixture = await tmpdir()
  const done = path.join(fixture.path, "revoked")
  const drained = path.join(fixture.path, "drained")
  const script = `
    import { Effect } from "effect";
    import { withGithubCallbacks, withGithubSignals } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/cli/cmd/github.lifecycle.ts"))};
    const task = Effect.acquireUseRelease(
      Effect.succeed(1),
      () => withGithubCallbacks((run) => Effect.promise(() => run(Effect.acquireUseRelease(
        Effect.sync(() => process.stdout.write("ready\\n")),
        () => Effect.never,
        () => Effect.promise(async () => { await Bun.sleep(20); await Bun.write(${JSON.stringify(drained)}, "drained") }),
      )))),
      () => Effect.promise(async () => {
        if (!await Bun.file(${JSON.stringify(drained)}).exists()) throw new Error("revoked before callback drainage");
        await Bun.write(${JSON.stringify(done)}, "revoked");
      }),
    );
    await Effect.runPromise(withGithubSignals(task)).catch(() => {});
    if (process.listenerCount("SIGTERM") || process.listenerCount("SIGINT")) throw new Error("signal listener leaked");
  `
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const reader = child.stdout.getReader()
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready")
    child.kill("SIGTERM")
    const code = await child.exited
    expect(code, await new Response(child.stderr).text()).toBe(143)
    expect(await Bun.file(done).text()).toBe("revoked")
  } finally {
    child.kill("SIGKILL")
    reader.releaseLock()
  }
}, 10000)
