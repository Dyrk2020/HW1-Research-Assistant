# Live capability tests (opt-in)

These tests exercise the real stack end to end: live search providers and a live
LLM. They are slow, nondeterministic, and spend provider quota, so they never run
by default. Everything in this directory is gated behind `LIVE=1`.

## Gate

```bash
bun test tests/live        # 100% skipped — LIVE is unset
LIVE=1 bun test tests/live # runs the live suites
```

Every test uses `test.skipIf` on the `LIVE` flag, so a plain `bun test` (and any
default CI job) stays green, offline, and free. Adding live files must never
change that: do not import them from default suites and never put `test:live`
in CI.

## Credentials (environment only — never commit a key)

Read at module load from these names, and only these names:

| Variable | Needed by | Notes |
| --- | --- | --- |
| `LIVE_LLM_BASE_URL` | summarize/ask test | OpenAI-compatible base URL, e.g. `http://127.0.0.1:8787/v1` |
| `LIVE_LLM_API_KEY` | summarize/ask test | sent to the server as `Authorization: Bearer …` |
| `LIVE_LLM_MODEL` | optional | omit to keep the server default (`deepseek/deepseek-v4.1-flash`) |
| `LIVE_EXA_API_KEY` | optional | omit to use the server's keyless public Exa MCP path |

The search test needs only `LIVE=1`. The LLM test additionally needs
`LIVE_LLM_BASE_URL` and `LIVE_LLM_API_KEY`; without them it reports as skipped
even when `LIVE=1`.

The tests forward these values into `startServer({...})` as
`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `EXA_API_KEY`. That indirection is
required: `tests/setup.ts` is preloaded and deletes the product names from the
test process, so the harness's own env is not trusted for live runs. Unset
`LIVE_*` variables are not forwarded at all, so the server's proxy-managed /
keyless defaults stay in force. Nothing is ever logged, asserted on, or written
to disk — keep secrets in your shell or an untracked `.env`, never in a test file.

## Commands

```bash
# 1. Default: everything skipped, safe for CI
bun test tests/live

# 2. Live search only (real network, no LLM credential required)
LIVE=1 bun test tests/live

# 3. Live search + live LLM (recommended shape for a full run)
LIVE=1 \
  LIVE_LLM_BASE_URL=http://127.0.0.1:8787/v1 \
  LIVE_LLM_API_KEY=... \
  LIVE_LLM_MODEL=deepseek/deepseek-v4.1-flash \
  LIVE_EXA_API_KEY=... \
  bun test tests/live

# 4. Same as 3 through the package script (it sets LIVE=1 itself)
LIVE_LLM_BASE_URL=... LIVE_LLM_API_KEY=... bun run test:live

# 5. One suite only
LIVE=1 bun test tests/live/capability.test.ts
```

## What is asserted

`capability.test.ts` talks HTTP to a real server from `tests/helpers/server.ts`;
it never imports `lib/*` and never stubs `fetch`.

1. **Live search** — `GET /api/search?q=retrieval augmented generation` returns
   `200`, `papers.length > 0`, and exactly four `sourceStatus` entries
   (`arXiv`, `Exa`, `OpenAlex`, `SemanticScholar`) with a valid status and a
   numeric `returnedCount`. At least one source must be `ok`; the others may
   report `limited` (rate limit / 8s timeout) or `error`. Papers must carry
   unique, non-empty ids because `/api/summarize` resolves them by id.
2. **Live LLM** — after a live search, the result with the longest abstract is
   sent to the real `GET /api/summarize?id=` and `GET /api/ask?id=&q=`. Both must
   answer `200 text/event-stream` with at least one `data:` frame, non-empty
   streamed text, and a terminating `data: [DONE]`. The server's mock fallback
   (text containing `(mock — set LLM …)`) fails the test, so an unreachable
   endpoint cannot pass. `[p.N]` citations are deliberately **not** required:
   search abstracts usually lack `<!-- Page N -->` markers, so demanding cites
   would make the test lie about the product.

## Operational notes

- Deterministic fake timers cannot drive a real socket read, so each SSE body is
  consumed under `AbortSignal.timeout` (120s); a stalled provider fails with a
  message instead of hanging the suite. Per-test timeouts are 120s for search
  and 360s for the LLM test (search + two streams).
- Every test starts its own ephemeral server on an OS-assigned port with a temp
  SQLite DB (`startServer`) and stops it in `try/finally`. No repo file, key, or
  existing test is mutated.
- Failures are usually provider weather, not product regressions: read the
  `warnings` / `sourceStatus` payload, the returned status, and whether the LLM
  test fell back to mock text. Re-run before filing a bug.
- `tests/live` also holds UI-level live suites; the `LIVE=1` gate is the shared
  contract.
