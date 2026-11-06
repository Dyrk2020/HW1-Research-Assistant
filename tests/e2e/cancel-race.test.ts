import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { startServer, type TestServer } from "../helpers/server.ts";

let server: TestServer;

// Chrome is optional: `bun test` must stay green on machines without it.
const browser: Browser | null = await chromium.launch({ channel: "chrome", headless: true }).catch(() => null);
if (!browser) console.warn("[e2e] Google Chrome unavailable; skipping Playwright tests");

const activePages: Page[] = [];
const openPage = async (): Promise<Page> => {
  const page = await browser!.newPage();
  activePages.push(page);
  return page;
};

afterEach(async () => {
  await Promise.all(activePages.splice(0).map((page) => page.close().catch(() => {})));
});

const paper = {
  id: "e1",
  title: "Cancel Race Paper",
  authors: ["Ada"],
  year: 2024,
  abstract: "abstract",
  link: "https://example.com",
  source: "exa",
  pdfPath: null,
};

const emptySearch = (route: Route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ papers: [], warnings: [], sourceStatus: [] }),
  });

// Serve a library paper and open it, so askFlow() has a selected paper without
// touching the real network or a real LLM.
async function openLibraryPaper(page: Page): Promise<void> {
  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/library", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ papers: [paper] }),
        })
      : route.continue(),
  );
  await page.goto(server.url);
  await page.click("#tabLib");
  await page.waitForSelector(".card");
  await page.click(".card button.primary");
  await page.waitForFunction(() =>
    (document.getElementById("paperInfo")?.textContent ?? "").includes("Cancel Race Paper"),
  );
}

const sse = (...chunks: string[]) => `${chunks.map((c) => `data: ${c}\n\n`).join("")}data: [DONE]\n\n`;

beforeAll(async () => {
  server = await startServer();
}, 60_000);

afterAll(async () => {
  // Stop the server first: a wedged browser close must not orphan the listener.
  const stopServer = server?.stop();
  await browser?.close().catch(() => {});
  await stopServer;
}, 30_000);

// The chat pane only speaks EventSource, so page.route can fulfill the SSE
// response but cannot emit it incrementally. Holding the fulfillment open still
// gives a genuinely in-flight request/stream phase, which is what Stop acts on.
test.skipIf(!browser)("Stop cancels an in-flight ask and suppresses the late answer", async () => {
  const page = await openPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await openLibraryPaper(page);

  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let lateFulfillError = "";
  await page.route("**/api/ask**", async (route: Route) => {
    started.resolve();
    await release.promise;
    try {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse('{"text":"LATE ANSWER [p.1]"}'),
      });
    } catch (e) {
      lateFulfillError = String(e);
    }
  });

  await page.fill("#askq", "What problem does it solve?");
  await page.click("#askBtn");
  await started.promise;

  const bubble = page.locator(".msg.model").last();
  await page.waitForSelector(".msg.model.streaming .typing");
  const modelBubbles = await page.locator(".msg.model").count();
  expect(await page.locator("#stopBtn").isEnabled()).toBe(true);
  expect(await page.locator("#askBtn").isEnabled()).toBe(false);

  await page.click("#stopBtn");
  expect(await page.locator("#stopBtn").isEnabled()).toBe(false);
  expect(await page.locator("#askBtn").isEnabled()).toBe(true);
  expect(await page.locator(".msg.model.streaming").count()).toBe(0);

  // Let the server-side response land after the user already stopped.
  release.resolve();
  await page.waitForTimeout(500);

  expect(await bubble.textContent()).toBe("");
  expect(await page.locator(".msg.model").count()).toBe(modelBubbles);
  expect(await page.locator("#errbar").isVisible()).toBe(false);
  expect(pageErrors).toEqual([]);
  expect(lateFulfillError).toBe("");
}, 30_000);

test.skipIf(!browser)("a second ask while one is pending replaces it without duplicating the answer", async () => {
  const page = await openPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await openLibraryPaper(page);

  // Ask is disabled while streaming, so the only second-submit path is Enter
  // in the composer; the first stream must be closed before the second opens.
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const urls: string[] = [];
  let seen = 0;
  await page.route("**/api/ask**", async (route: Route) => {
    const n = seen++;
    urls.push(route.request().url());
    started[n]?.resolve();
    await gates[n]?.promise;
    try {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse(JSON.stringify({ text: `ANSWER ${n + 1} [p.1]` })),
      });
    } catch {
      // The first stream was already closed by the second ask — expected.
    }
  });

  await page.fill("#askq", "first question");
  await page.click("#askBtn");
  await started[0]!.promise;
  expect(await page.locator("#askBtn").isEnabled()).toBe(false);
  expect(await page.locator("#stopBtn").isEnabled()).toBe(true);

  const modelBubbles = await page.locator(".msg.model").count();
  const firstBubble = page.locator(".msg.model").nth(modelBubbles - 1);

  await page.fill("#askq", "second question");
  await page.keyboard.press("Enter");
  await started[1]!.promise;
  expect(seen).toBe(2);
  expect(new URL(urls[1]!).searchParams.get("q")).toBe("second question");
  expect(await page.locator(".msg.model").count()).toBe(modelBubbles + 1);
  expect(await page.locator("#stopBtn").isEnabled()).toBe(true);
  expect(await page.locator("#askBtn").isEnabled()).toBe(false);

  gates[1]!.resolve();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".msg.model")].some((b) => b.textContent?.includes("ANSWER 2 [p.1]")),
  );

  // Release the abandoned first request: it must not reach the old bubble.
  gates[0]!.resolve();
  await page.waitForTimeout(500);

  expect(await firstBubble.textContent()).toBe("");
  expect(await page.locator(".msg.model", { hasText: "ANSWER 1" }).count()).toBe(0);
  expect(await page.locator(".msg.model", { hasText: "ANSWER 2 [p.1]" }).count()).toBe(1);
  expect(await page.locator("#stopBtn").isEnabled()).toBe(false);
  expect(await page.locator("#askBtn").isEnabled()).toBe(true);
  expect(await page.locator("#errbar").isVisible()).toBe(false);
  expect(pageErrors).toEqual([]);
}, 30_000);

test.skipIf(!browser)("a malformed SSE payload stays in one bubble and leaves controls consistent", async () => {
  const page = await openPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await openLibraryPaper(page);

  await page.route("**/api/ask**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      // Not JSON: askFlow() falls back to pushing the raw frame as text.
      body: sse("{not json at all", '{"text":"tail [p.2]"}'),
    }),
  );

  const modelBubbles = await page.locator(".msg.model").count();
  await page.fill("#askq", "malformed");
  await page.click("#askBtn");

  await page.waitForFunction(() =>
    [...document.querySelectorAll(".msg.model")].some((b) => b.textContent?.includes("tail [p.2]")),
  );

  expect(await page.locator(".msg.model").count()).toBe(modelBubbles + 1);
  const answer = await page.locator(".msg.model").last().textContent();
  expect(answer).toContain("{not json at all");
  expect(answer).toContain("tail [p.2]");
  expect(await page.locator("#stopBtn").isEnabled()).toBe(false);
  expect(await page.locator("#askBtn").isEnabled()).toBe(true);
  expect(await page.locator("#errbar").isVisible()).toBe(false);
  expect(pageErrors).toEqual([]);
}, 30_000);

test.skipIf(!browser)("a failed ask shows one fallback bubble, no reconnect, and usable buttons", async () => {
  const page = await openPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await openLibraryPaper(page);

  let hits = 0;
  await page.route("**/api/ask**", (route) => {
    hits++;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "boom" }),
    });
  });

  const modelBubbles = await page.locator(".msg.model").count();
  await page.fill("#askq", "will fail");
  await page.click("#askBtn");

  await page.waitForFunction(() =>
    [...document.querySelectorAll(".msg.model")].some((b) =>
      b.textContent?.includes("No answer — paper not found on server"),
    ),
  );

  expect(await page.locator(".msg.model").count()).toBe(modelBubbles + 1);
  expect(await page.locator(".msg.model.streaming").count()).toBe(0);
  expect(await page.locator("#stopBtn").isEnabled()).toBe(false);
  expect(await page.locator("#askBtn").isEnabled()).toBe(true);
  expect(await page.locator("#errbar").isVisible()).toBe(false);
  expect(pageErrors).toEqual([]);

  // EventSource retries by default; stopChat() closes it, so exactly one request.
  await page.waitForTimeout(500);
  expect(hits).toBe(1);
}, 30_000);
