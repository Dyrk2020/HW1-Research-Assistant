# HW1 Research Assistant (MVP)

Pi 底座 + bun + SQLite + Pi native C 引擎。三屏: 选文 | 对话 | 预览。

## Run

```bash
bun install
bun run server.ts
# open http://localhost:4321
```

## Keys (all optional — graceful fallback)

```bash
export LLM_BASE_URL=http://127.0.0.1:8787/v1          # default: local proxy
export LLM_MODEL=deepseek/deepseek-v4.1-flash          # default Flash
export LLM_API_KEY=                                    # default: proxy-managed
export EXA_API_KEY=                                    # unset -> keyless public MCP
export UPLOAD_CONCURRENCY=2
```

Never commit keys (`.gitignore` covers `.env`, `*.db`, `papers/`). Agent page has a Keys panel: status-only read + `.env` line preview (page never POSTs keys).

## API

- `GET /api/search?q=` — 4-source bundle `{papers, warnings, sourceStatus[]}`: Exa (key or keyless MCP) + SS + OpenAlex + arXiv; 12-token near-dedupe; 7-day cache (100 LRU); 8s per-source timeout
- `GET/POST /api/library`, `DELETE /api/library/:id` — SQLite (`lib/papers.db`) + FTS5
- `POST /api/upload` (multipart `file`) — queued (concurrency 2); Pi native `pdfToMarkdown` + H1 title fallback; content-hash id (`pdf:<sha16>`, dedupe); returns `{paper, queue}`
- `POST /api/fetch` (`{url, title?}`) — SSRF-guarded + 75MB cap + HEAD-tolerant; same extract path; seamless online→local
- `GET /api/queue` — `{active, queued, concurrency}`
- `GET /api/pdf/:id` — PDF bytes for preview
- `GET /api/read?id=&offset=&limit=` — paged text cursor `{text, nextOffset, endOfDocument}`
- `GET /api/summarize?id=` (SSE) — 3 numbered points, page-segmented cites
- `GET /api/ask?id=&q=` (SSE) — ≤5 sentences × 40 words, one cite each, page-varied
- `GET /api/settings` — `{llm: {baseUrl, model, keySet, mode}, exa: {...}}` (no values)

## Measured

- Search cold ~1.3-8s (SS 429-bound) → warm 36-44ms; 20-26 papers keyless
- Native PDF 18-19ms/4p (hw1.pdf, true text + `<!-- Page N -->`); TS fallback 31ms
- Upload queue: 3 concurrent → active 2 + 1 queued
- Boot: `bun run` 0.22s ready
- E2E (computer-use, 3/3 ✅) + UI loop v1-v6 → `demo-hw1-v6.mp4`

## Known gaps

- Ask feeds 6000-char excerpt (no embedding rerank yet) — next: full-text cursor + sqlite-vec
- Single-file `index.html` — Astro islands migration per PLAN §3
