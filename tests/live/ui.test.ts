// Opt-in live E2E: real Chrome + real network, with no route mocks.
//
// Default `bun test` skips this file. Enable it with:
//   LIVE=1 LIVE_LLM_BASE_URL=... [LIVE_LLM_API_KEY=...] [LIVE_LLM_MODEL=...] [LIVE_EXA_API_KEY=...] bun test tests/live
//
// Credentials are read from the environment only: nothing here writes, logs, or
// embeds them in test names or failure messages. Live tests are inherently
// network- and rate-limit-dependent, so timeouts are deliberately generous.
import { afterAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { startServer, type TestServer } from "../helpers/server.ts";

const live = process.env.LIVE === "1";
const QUERY = "retrieval augmented generation";
const SEARCH_TIMEOUT_MS = 150_000;
const CHAT_TIMEOUT_MS = 150_000;
const TEST_TIMEOUT_MS = 300_000;

const liveLlmBase = process.env.LIVE_LLM_BASE_URL;
const liveLlmKey = process.env.LIVE_LLM_API_KEY;
// `proxy-managed` is the server's public mode label, not a credential.
const leakCheckKey = liveLlmKey && liveLlmKey !== "proxy-managed" ? liveLlmKey : "";
const liveLlmModel = process.env.LIVE_LLM_MODEL;
const liveExaKey = process.env.LIVE_EXA_API_KEY;

// Chrome stays optional, exactly like the mocked E2E suite.
const browser: Browser | null = live
  ? await chromium.launch({ channel: "chrome", headless: true }).catch(() => null)
  : null;
if (live && !browser) console.warn("[live-e2e] Google Chrome unavailable; skipping live UI tests");

const liveReady = live && browser !== null;
// The ask flow is only meaningful with a real endpoint; search works keyless.
const llmReady = liveReady && Boolean(liveLlmBase);

afterAll(async () => {
  await browser?.close().catch(() => {});
}, 30_000);

// Translate the opt-in LIVE_* variables onto the names the server reads.
function liveServerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (liveLlmBase) env.LLM_BASE_URL = liveLlmBase;
  if (liveLlmKey) env.LLM_API_KEY = liveLlmKey;
  if (liveLlmModel) env.LLM_MODEL = liveLlmModel;
  if (liveExaKey) env.EXA_API_KEY = liveExaKey;
  return env;
}

// Each test owns its server and page; both are always torn down.
async function withLivePage(run: (page: Page, server: TestServer) => Promise<void>): Promise<void> {
  const server = await startServer(liveServerEnv());
  let page: Page | null = null;
  try {
    page = await browser!.newPage();
    await run(page, server);
  } finally {
    await page?.close().catch(() => {});
    await server.stop();
  }
}

// The picker exposes its search lifecycle on #src[data-state].
async function waitForSearchSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const state = document.getElementById("src")?.dataset.state;
      return state === "idle" || state === "error";
    },
    null,
    { timeout: SEARCH_TIMEOUT_MS },
  );
}

// Drive the real search and wait until the UI has mounted result cards, or the
// error bar reports that every upstream source failed. The app also auto-runs
// the default query on load, so settle that first and then clear the view: only
// the explicit search below can repopulate it, keeping card selection race-free.
async function searchForCards(page: Page, server: TestServer): Promise<void> {
  await page.goto(server.url);
  await waitForSearchSettled(page);
  await page.fill("#q", QUERY);
  await page.evaluate(() => {
    const results = document.getElementById("results");
    if (results) results.innerHTML = "";
  });
  await page.click("#searchBtn");
  await waitForSearchSettled(page);
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#results .card").length > 0 ||
      document.getElementById("errbar")?.style.display === "block",
    null,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  const count = await page.locator("#results .card").count();
  expect(count, "live search returned no result cards (network or upstream source unavailable)").toBeGreaterThan(0);
}

async function selectFirstResult(page: Page): Promise<string> {
  const card = page.locator("#results .card").first();
  const title = ((await card.locator("h4").textContent()) ?? "").trim();
  await card.locator("button.primary").click();
  // renderPdfBar() replaces the placeholder as soon as a paper is selected.
  await page.waitForFunction(
    () => ((document.getElementById("paperInfo")?.textContent ?? "").trim() !== "Select a paper →"),
    null,
    { timeout: 30_000 },
  );
  return title;
}

async function askAndReadAnswer(page: Page): Promise<string> {
  // Init and paper selection already append system bubbles, so count first.
  const priorModels = await page.locator("#msgs .msg.model").count();
  await page.fill("#askq", "What problem does this paper address?");
  await page.click("#askBtn");
  await page.waitForFunction(
    (prior) => {
      const nodes = document.querySelectorAll("#msgs .msg.model");
      if (nodes.length <= prior) return false;
      const last = nodes[nodes.length - 1] as HTMLElement;
      return (last.textContent ?? "").trim().length > 0 && !last.querySelector(".typing");
    },
    priorModels,
    { timeout: CHAT_TIMEOUT_MS },
  );
  return ((await page.locator("#msgs .msg.model").last().textContent()) ?? "").trim();
}

test.skipIf(!liveReady)(
  "live search renders real result cards from the network",
  async () => {
    await withLivePage(async (page, server) => {
      await searchForCards(page, server);

      const cards = page.locator("#results .card");
      const count = await cards.count();
      expect(count).toBeGreaterThan(0);

      const firstTitle = ((await cards.first().locator("h4").textContent()) ?? "").trim();
      expect(firstTitle.length).toBeGreaterThan(0);

      // Real source status is rendered only after a live /api/search response.
      const status = ((await page.locator("#src").textContent()) ?? "").trim();
      expect(status.length).toBeGreaterThan(0);
      // The app never logs raw keys; assert the page did not receive one.
      // Compare as a boolean so a failure can never print the secret.
      if (leakCheckKey) {
        const body = await page.content();
        expect(body.includes(leakCheckKey), "the page leaked a configured credential").toBe(false);
      }
    });
  },
  TEST_TIMEOUT_MS,
);

test.skipIf(!llmReady)(
  "live ask streams a real answer for a selected result",
  async () => {
    await withLivePage(async (page, server) => {
      await searchForCards(page, server);
      const title = await selectFirstResult(page);
      expect(title.length).toBeGreaterThan(0);

      const answer = await askAndReadAnswer(page);

      // The user's question is echoed into the transcript.
      expect(await page.locator("#msgs .msg.user").count()).toBeGreaterThan(0);
      // SSE-driven output arrived and is not the server's mock fallback.
      expect(answer.length).toBeGreaterThan(0);
      expect(answer.includes("(mock —"), "server fell back to its mock answer").toBe(false);
      expect(answer.includes("No answer — paper not found"), "the selected paper was not resolvable").toBe(false);
      if (leakCheckKey) expect(answer.includes(leakCheckKey), "the answer leaked a configured credential").toBe(false);
    });
  },
  TEST_TIMEOUT_MS,
);
