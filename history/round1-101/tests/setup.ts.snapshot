// Preloaded for every `bun test` run (see bunfig.toml). Bun shares one module
// registry across test files, so the DB/PAPERS paths must be decided once,
// before lib/db.ts or server.ts is first evaluated.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), `hw2-suite-${process.pid}`);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

process.env.DB_PATH = join(dir, "papers.db");
process.env.PAPERS_DIR = join(dir, "papers");
process.env.LLM_BASE_URL = "http://127.0.0.1:9/v1";
process.env.UPLOAD_CONCURRENCY = "1";
delete process.env.EXA_API_KEY;

process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
