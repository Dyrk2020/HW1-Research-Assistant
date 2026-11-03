// Preloaded for every `bun test` run (see bunfig.toml). Bun shares one module
// registry across test files, so the DB/PAPERS paths must be decided once,
// before lib/db.ts or server.ts is first evaluated.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Reap temp dirs left by earlier runs (including crashed runs). Do not clean in
// afterAll: Bun re-runs it between --rerun-each iterations, which would delete
// the still-open SQLite file.
const root = tmpdir();
for (const entry of readdirSync(root)) {
  if (!entry.startsWith("hw2-suite-")) continue;
  const path = join(root, entry);
  try {
    if (Date.now() - statSync(path).mtimeMs > 60_000) rmSync(path, { recursive: true, force: true });
  } catch {
    // another process may be using it
  }
}

const dir = join(root, `hw2-suite-${process.pid}`);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

process.env.DB_PATH = join(dir, "papers.db");
process.env.PAPERS_DIR = join(dir, "papers");
process.env.LLM_BASE_URL = "http://127.0.0.1:9/v1";
process.env.UPLOAD_CONCURRENCY = "1";
delete process.env.LLM_API_KEY;
delete process.env.LLM_MODEL;
delete process.env.EXA_API_KEY;
