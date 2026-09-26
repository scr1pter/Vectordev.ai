import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`Actions ${signal} awaits credential finalizers through repeated signals`, async () => {
    await using fixture = await tmpdir()
    const done = path.join(fixture.path, "revoked")
    const drained = path.join(fixture.path, "drained")
    const script = `
    import { Effect } from "effect";
    import { withGithubCallbacks, withGithubSignals } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/cli/cmd/github.lifecycle.ts"))};
    const task = Effect.acquireUseRelease(
      Effect.succeed(1),
      () => withGithubCallbacks((run) => Effect.promise(() => run(Effect.acquireUseRelease(
        Effect.sync(() => {
          if (!process.listenerCount("SIGTERM") || !process.listenerCount("SIGINT"))
            throw new Error("job started before cancellation listeners");
          process.stdout.write("ready\\n");
        }),
        () => Effect.never,
        () => Effect.promise(async () => {
          process.stdout.write("draining\\n");
          await Bun.sleep(100);
          await Bun.write(${JSON.stringify(drained)}, "drained");
        }),
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
      child.kill(signal)
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("draining")
      child.kill(signal === "SIGTERM" ? "SIGINT" : "SIGTERM")
      await Bun.sleep(10)
      child.kill(signal)
      const code = await child.exited
      expect(code, await new Response(child.stderr).text()).toBe(signal === "SIGTERM" ? 143 : 130)
      expect(await Bun.file(done).text()).toBe("revoked")
    } finally {
      child.kill("SIGKILL")
      reader.releaseLock()
    }
  }, 10000)
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`Actions ${signal} determines exit status when the job completes in the same turn`, async () => {
    const script = `
      import { Effect } from "effect";
      import { withGithubSignals } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/cli/cmd/github.lifecycle.ts"))};
      await Effect.runPromise(withGithubSignals(Effect.sync(() => {
        process.emit(${JSON.stringify(signal)});
        process.emit(${JSON.stringify(signal === "SIGTERM" ? "SIGINT" : "SIGTERM")});
      })));
      if (process.listenerCount("SIGTERM") || process.listenerCount("SIGINT")) throw new Error("signal listener leaked");
    `
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
    })
    expect(await child.exited, await new Response(child.stderr).text()).toBe(signal === "SIGTERM" ? 143 : 130)
  }, 10000)
}
