# Historical test snapshots

These are read-only archives reconstructed from the omp session log, not the
current test suite. They are stored as `*.snapshot` so `bun test` does not
execute them.

- `initial-70/` — session cutoff `2026-11-03T14:17:01Z`: 65 Bun + 5 E2E,
  64/1 Bun (one `createdAt` failure), 5/5 E2E, B1–B4 already pinned.
  `tests/setup.ts` and `bunfig.toml` did not exist yet at this cutoff.
- `round1-101/` — session cutoff `2026-11-03T14:23:30Z`: 101 tests,
  11 pins, 202 expects, `pdf` 100%, `search` 98.85%, `server` 98.54%.

The current app at `main` is not the historical app state, so these snapshots
are for provenance and review, not expected to run against HEAD. Remove the
`.snapshot` suffix to inspect a file as TypeScript.
