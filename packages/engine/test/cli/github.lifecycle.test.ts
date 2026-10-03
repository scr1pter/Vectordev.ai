import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

// Windows terminates Bun children immediately on child.kill; exercise the handlers through stdin there.
for (const delivery of process.platform === "win32" ? ["stdin"] : ["signal", "stdin"]) {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`Actions ${signal} via ${delivery} awaits credential finalizers through repeated signals`, async () => {
      await using fixture = await tmpdir()
      const done = path.join(fixture.path, "revoked")
      const drained = path.join(fixture.path, "drained")
      const script = `
    import { Effect } from "effect";
    import { createInterface } from "node:readline";
    import { withGithubCallbacks, withGithubSignals } from ${JSON.stringify(new URL("../../src/cli/cmd/github.lifecycle.ts", import.meta.url).href)};
    const input = ${delivery === "stdin"} ? createInterface({ input: process.stdin }) : undefined;
    input?.on("line", (signal) => process.emit(signal));
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
    input?.close();
    if (process.listenerCount("SIGTERM") || process.listenerCount("SIGINT")) throw new Error("signal listener leaked");
  `
      const child = Bun.spawn([process.execPath, "--eval", script], {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
        stdin: "pipe",
      })
      const reader = child.stdout.getReader()
      const send = (value: "SIGTERM" | "SIGINT") => {
        if (delivery === "stdin") return child.stdin.write(`${value}\n`)
        child.kill(value)
      }
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready")
        await send(signal)
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("draining")
        await send(signal === "SIGTERM" ? "SIGINT" : "SIGTERM")
        await Bun.sleep(10)
        await send(signal)
        child.stdin.end()
        const code = await child.exited
        expect(code, await new Response(child.stderr).text()).toBe(signal === "SIGTERM" ? 143 : 130)
        expect(await Bun.file(done).text()).toBe("revoked")
      } finally {
        child.kill("SIGKILL")
        await child.exited
        reader.releaseLock()
      }
    }, 10000)
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`Actions ${signal} determines exit status when the job completes in the same turn`, async () => {
    const script = `
      import { Effect } from "effect";
      import { withGithubSignals } from ${JSON.stringify(new URL("../../src/cli/cmd/github.lifecycle.ts", import.meta.url).href)};
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
