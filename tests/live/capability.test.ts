// Live capability tests: real network, real provider responses, real LLM.
//
// Opt-in only. Without LIVE=1 every test here is skipped, so the default
// `bun test` run stays green and offline.
//
// Credentials are read exclusively from the environment, never from the repo:
//   LIVE_LLM_BASE_URL, LIVE_LLM_API_KEY, LIVE_LLM_MODEL, LIVE_EXA_API_KEY
// They are forwarded to the spawned server as LLM_BASE_URL / LLM_API_KEY /
// LLM_MODEL / EXA_API_KEY, because tests/setup.ts deletes those names from the
// runner's environment (preload) before this module is evaluated.
//
// Black-box only: these tests speak HTTP to `startServer()`, never import lib/*.
import { describe, expect, test } from "bun:test";
import { startServer } from "../helpers/server.ts";

const LIVE = process.env.LIVE === "1";

// Read once at module load; never logged, never written anywhere.
const liveLlmBaseUrl = process.env.LIVE_LLM_BASE_URL?.trim() ?? "";
const liveLlmApiKey = process.env.LIVE_LLM_API_KEY?.trim() ?? "";
const liveLlmModel = process.env.LIVE_LLM_MODEL?.trim() ?? "";
const liveExaApiKey = process.env.LIVE_EXA_API_KEY?.trim() ?? "";

// Gate for the LLM half: endpoint + credential. LIVE_LLM_MODEL is optional
// (the server falls back to its own default model when unset).
const LLM_READY = LIVE && Boolean(liveLlmBaseUrl && liveLlmApiKey);

const QUERY = "retrieval augmented generation";
const SEARCH_TIMEOUT_MS = 120_000;
const SSE_TIMEOUT_MS = 120_000;

// Source result statuses the server is allowed to report (lib/search.ts).
const SOURCE_STATUSES = ["ok", "limited", "error", "skipped"];
const SOURCE_NAMES = ["arXiv", "Exa", "OpenAlex", "SemanticScholar"];

type LivePaper = { id: string; title: string; abstract: string; source: string };
type LiveSourceStatus = { source: string; status: string; returnedCount: number };
type LiveBundle = { papers: LivePaper[]; warnings: string[]; sourceStatus: LiveSourceStatus[] };

type SseCapture = {
  status: number;
  contentType: string;
  frames: string[];
  text: string;
  sawDone: boolean;
};

// Forward only the keys the caller actually provided: an empty string would
// mask the server's proxy-managed/keyless defaults with a dead endpoint.
function liveServerEnv(): Record<string, string> {
  const overrides: Record<string, string> = {};
  if (liveExaApiKey) overrides.EXA_API_KEY = liveExaApiKey;
  if (liveLlmBaseUrl) overrides.LLM_BASE_URL = liveLlmBaseUrl;
  if (liveLlmApiKey) overrides.LLM_API_KEY = liveLlmApiKey;
  if (liveLlmModel) overrides.LLM_MODEL = liveLlmModel;
  return overrides;
}

// A data frame is either raw streamed text (live LLM path) or JSON {text}
// (the server's mock fallback). Accept both so the assertion is about content.
function decodeFrame(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object" && "text" in parsed && typeof parsed.text === "string") return parsed.text;
  } catch {
    // raw text frame, not JSON
  }
  return payload;
}

// Consume the SSE body incrementally under a hard deadline: a stalled LLM must
// fail the test instead of hanging the suite. Deterministic timers cannot drive
// a real network read, so the deadline rides the platform abort signal, which
// also cancels the open socket and the server's response stream.
async function readSse(url: string): Promise<SseCapture> {
  const signal = AbortSignal.timeout(SSE_TIMEOUT_MS);
  const res = await fetch(url, { signal });
  const contentType = res.headers.get("content-type") ?? "";
  const empty: SseCapture = { status: res.status, contentType, frames: [], text: "", sawDone: false };
  if (!res.body) return empty;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      raw += decoder.decode(chunk.value, { stream: true });
      if (raw.includes("data: [DONE]")) break;
    }
  } catch (error) {
    if (signal.aborted) throw new Error(`SSE stream did not finish within ${SSE_TIMEOUT_MS}ms (received ${raw.length} bytes)`);
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
  }
  raw += decoder.decode();

  const frames: string[] = [];
  let sawDone = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const rawPayload = line.slice("data:".length);
    const payload = rawPayload.startsWith(" ") ? rawPayload.slice(1) : rawPayload;
    if (payload.trim() === "[DONE]") {
      sawDone = true;
      break;
    }
    if (payload.trim()) frames.push(payload);
  }

  return { status: res.status, contentType, frames, sawDone, text: frames.map(decodeFrame).join("").trim() };
}

function expectRealSse(capture: SseCapture): void {
  expect(capture.status).toBe(200);
  expect(capture.contentType).toContain("text/event-stream");
  expect(capture.frames.length).toBeGreaterThan(0);
  expect(capture.sawDone).toBe(true);
  expect(capture.text.length).toBeGreaterThan(0);
  // The mock fallback means the live LLM call failed; never accept it here.
  expect(capture.text).not.toMatch(/\(mock\b|mock — set LLM/);
}

async function fetchBundle(baseUrl: string): Promise<LiveBundle> {
  const res = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(QUERY)}`);
  expect(res.status).toBe(200);
  return (await res.json()) as LiveBundle;
}

describe("live capability (LIVE=1)", () => {
  test.skipIf(!LIVE)(
    "real /api/search returns papers and a per-source status breakdown",
    async () => {
      const server = await startServer(liveServerEnv());
      try {
        const body = await fetchBundle(server.url);

        expect(Array.isArray(body.papers)).toBe(true);
        expect(body.papers.length).toBeGreaterThan(0);
        expect(Array.isArray(body.warnings)).toBe(true);

        // Four sources always report, even when one degrades.
        expect(body.sourceStatus).toHaveLength(4);
        expect(body.sourceStatus.map((s) => s.source).sort()).toEqual([...SOURCE_NAMES].sort());
        for (const status of body.sourceStatus) {
          expect(SOURCE_STATUSES).toContain(status.status);
          expect(typeof status.returnedCount).toBe("number");
        }
        // Live network must reach at least one provider; degraded providers are fine.
        expect(body.sourceStatus.filter((s) => s.status === "ok").length).toBeGreaterThanOrEqual(1);

        for (const paper of body.papers) {
          expect(typeof paper.id).toBe("string");
          expect(paper.id.length).toBeGreaterThan(0);
        }
        // merged results must be addressable: /api/summarize resolves by id.
        expect(new Set(body.papers.map((p) => p.id)).size).toBe(body.papers.length);
      } finally {
        await server.stop();
      }
    },
    SEARCH_TIMEOUT_MS,
  );

  test.skipIf(!LLM_READY)(
    "real /api/summarize and /api/ask stream SSE for a search-result id",
    async () => {
      const server = await startServer(liveServerEnv());
      try {
        const body = await fetchBundle(server.url);
        // Summaries are built from the stored abstract; pick the richest one so
        // the model has real material and the citation requirement can vary.
        const withAbstract = body.papers.filter((p) => typeof p.abstract === "string" && p.abstract.trim().length > 0);
        expect(withAbstract.length).toBeGreaterThan(0);
        const paper = withAbstract.reduce((best, p) => (p.abstract.length > best.abstract.length ? p : best));

        const summarize = await readSse(`${server.url}/api/summarize?id=${encodeURIComponent(paper.id)}`);
        expectRealSse(summarize);

        const ask = await readSse(
          `${server.url}/api/ask?id=${encodeURIComponent(paper.id)}&q=${encodeURIComponent("What does this paper contribute?")}`,
        );
        expectRealSse(ask);

        // Same paper, different prompts: the answers must not be byte-identical.
        expect(ask.text).not.toBe(summarize.text);
      } finally {
        await server.stop();
      }
    },
    SEARCH_TIMEOUT_MS + 2 * SSE_TIMEOUT_MS,
  );
});
