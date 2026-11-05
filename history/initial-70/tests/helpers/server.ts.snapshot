// Black-box server harness: spawns `bun server.ts` on an ephemeral port and
// discovers the port from the startup log line, so tests never race a fixed port.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");

export type TestServer = {
  url: string;
  port: number;
  stop: () => Promise<void>;
};

export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const dir = await mkdtemp(join(tmpdir(), "hw2-server-"));
  const dbPath = join(dir, "papers.db");
  const proc = Bun.spawn(["bun", "server.ts"], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: "0",
      DB_PATH: dbPath,
      LLM_BASE_URL: "http://127.0.0.1:9/v1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const match = buf.match(/MVP on http:\/\/localhost:(\d+)/);
    if (!match) continue;

    const port = Number(match[1]);
    void (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
        }
      } catch {
        // process exited
      }
    })();

    return {
      url: `http://127.0.0.1:${port}`,
      port,
      async stop() {
        proc.kill();
        await proc.exited;
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  proc.kill();
  throw new Error(`server did not start: ${buf}`);
}
