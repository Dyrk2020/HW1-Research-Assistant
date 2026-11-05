import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");

test("boots as a real process and serves the queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hw2-boot-"));
  const child = spawn(process.execPath, ["run", "server.ts"], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: "0",
      DB_PATH: join(dir, "papers.db"),
      PAPERS_DIR: join(dir, "papers"),
      UPLOAD_CONCURRENCY: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const started = Promise.withResolvers<number>();
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const match = output.match(/MVP on http:\/\/localhost:(\d+)/);
    if (match) started.resolve(Number(match[1]));
  });
  child.on("exit", (code) => started.reject(new Error(`server exited early: ${code}\n${output}`)));
  const exited = Promise.withResolvers<void>();
  child.once("exit", () => exited.resolve());

  try {
    const port = await started.promise;
    const res = await fetch(`http://127.0.0.1:${port}/api/queue`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ active: 0, queued: 0, concurrency: 1 });
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited.promise;
    await rm(dir, { recursive: true, force: true });
  }
}, 25_000);
