import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { makePdf } from "../helpers/pdf.ts";
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
  title: "Queue Paper",
  authors: ["Ada"],
  year: 2024,
  abstract: "abstract",
  link: "https://example.com",
  source: "exa",
  pdfPath: null,
};

const bundle = (papers: unknown[]) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ papers, warnings: [], sourceStatus: [] }),
});

const emptySearch = (route: Route) => route.fulfill(bundle([]));

const jsonBody = (status: number, value: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(value),
});

const pdfFile = (pages: string[]) => ({
  name: "reader-queue.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from(makePdf({ pages })),
});

/** Bounded poll: page.route handlers run asynchronously after the request event. */
const until = async (page: Page, predicate: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await page.waitForTimeout(20);
};

beforeAll(async () => {
  server = await startServer();
}, 60_000);

afterAll(async () => {
  // Stop the server first: a wedged browser close must not orphan the listener.
  const stopServer = server?.stop();
  await browser?.close().catch(() => {});
  await stopServer;
}, 30_000);

test.skipIf(!browser)("paginates a real two-page PDF with prev/next", async () => {
  // Real upload: the pdfrx reader needs actual PDF bytes served by the server.
  const form = new FormData();
  form.append("file", new File([makePdf({ pages: ["first page", "second page"] })], "two-pages.pdf", { type: "application/pdf" }));
  const upload = await fetch(`${server.url}/api/upload`, { method: "POST", body: form });
  expect(upload.status).toBe(201);

  const page = await openPage();
  await page.route("**/api/search**", emptySearch);
  await page.goto(server.url);
  await page.click("#tabLib");
  await page.waitForSelector(".card");
  await page.click(".card button.primary");

  await page.waitForFunction(
    () => (document.getElementById("pdfOverlay") as HTMLElement | null)?.style.display === "none",
    null,
    { timeout: 45_000 },
  );
  expect(await page.locator("#pdfCanvasHost canvas").count()).toBeGreaterThan(0);
  await page.waitForFunction(() => document.getElementById("pageInfo")?.textContent?.startsWith("1 / 2"));

  // The pdf bar ships no zoom control; this test must not invent one.
  const tools = await page
    .locator("#pdfBar button")
    .evaluateAll((els) => els.map((el) => `${el.id} ${el.textContent ?? ""} ${el.getAttribute("title") ?? ""}`));
  expect(tools.some((label) => /zoom/i.test(label))).toBe(false);

  expect(await page.locator("#pageInfo").textContent()).toContain("1 / 2");
  expect(await page.locator("#pdfPrev").isDisabled()).toBe(true);
  expect(await page.locator("#pdfNext").isEnabled()).toBe(true);

  await page.click("#pdfNext");
  await page.waitForFunction(() => document.getElementById("pageInfo")?.textContent?.startsWith("2 / 2"));
  expect(await page.locator("#pdfPrev").isEnabled()).toBe(true);
  expect(await page.locator("#pdfNext").isDisabled()).toBe(true);

  await page.click("#pdfPrev");
  await page.waitForFunction(() => document.getElementById("pageInfo")?.textContent?.startsWith("1 / 2"));
  expect(await page.locator("#pdfPrev").isDisabled()).toBe(true);
  expect(await page.locator("#pdfNext").isEnabled()).toBe(true);

  await page.close();
}, 60_000);

test.skipIf(!browser)("holds the pending upload state, then selects the queued paper", async () => {
  const page = await openPage();
  const uploaded = { ...paper, id: "q1", title: "Queued Paper", source: "upload" };
  let pending: Route | null = null;
  let uploads = 0;

  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/upload", (route) => {
    uploads++;
    pending = route;
  });
  await page.route("**/api/library", (route) =>
    route.request().method() === "GET"
      ? route.fulfill(jsonBody(200, { papers: [uploaded] }))
      : route.continue(),
  );
  await page.goto(server.url);

  await page.setInputFiles("#file", pdfFile(["pending page"]));
  const firstRequest = page.waitForRequest((r) => r.url().endsWith("/api/upload"));
  await page.click("#uploadBtn");
  await firstRequest;
  await until(page, () => pending !== null);

  // While the request is in flight the button is disabled and no second POST escapes.
  expect(await page.locator("#uploadBtn").isDisabled()).toBe(true);
  expect(pending).not.toBeNull();
  await page.evaluate(() => {
    const btn = document.getElementById("uploadBtn") as HTMLButtonElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    btn.click();
  });
  await page.waitForTimeout(250);
  expect(uploads).toBe(1);

  await pending!.fulfill(jsonBody(201, { paper: uploaded, queue: { active: 0, queued: 0, concurrency: 1 } }));

  await page.waitForFunction(() => document.getElementById("uploadBtn")?.hasAttribute("disabled") === false);
  await page.waitForFunction(() => document.getElementById("paperInfo")?.textContent?.includes("Queued Paper"));
  await page.waitForFunction(() => document.getElementById("queueInfo")?.textContent === "parse 0/1");
  await page.waitForFunction(() => document.getElementById("libCount")?.textContent === "library(1)");

  expect(uploads).toBe(1);
  expect(await page.locator("#uploadBtn").isEnabled()).toBe(true);
  expect(await page.locator("#queueInfo").textContent()).toBe("parse 0/1");
  expect(await page.locator("#paperInfo").textContent()).toBe("Queued Paper");
  expect(await page.locator("#tabLib").getAttribute("aria-selected")).toBe("true");
  expect(await page.locator("#libCount").textContent()).toBe("library(1)");
  expect(await page.locator(".card").count()).toBe(1);
  expect(await page.locator(".card[aria-current='true']").count()).toBe(1);

  await page.close();
}, 30_000);

test.skipIf(!browser)("keeps one card when the same paper is uploaded twice", async () => {
  const page = await openPage();
  const dup = { ...paper, id: "dup-1", title: "Duplicate Paper", source: "upload" };
  let uploads = 0;

  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/upload", (route) => {
    uploads++;
    return route.fulfill(jsonBody(201, { paper: dup, queue: { active: 0, queued: 0, concurrency: 1 } }));
  });
  await page.route("**/api/library", (route) =>
    route.request().method() === "GET"
      ? route.fulfill(jsonBody(200, { papers: [dup] }))
      : route.continue(),
  );
  await page.goto(server.url);
  await page.setInputFiles("#file", pdfFile(["duplicate page"]));

  const opened = (n: number) =>
    page.waitForFunction(
      (count) => [...document.querySelectorAll(".msg.model")].filter((b) => b.textContent?.includes("Opened")).length === count,
      n,
    );

  await page.click("#uploadBtn");
  await opened(1);
  await page.waitForFunction(() => document.getElementById("libCount")?.textContent === "library(1)");
  expect(await page.locator(".card").count()).toBe(1);

  // Same paper id again: the library GET still returns a single paper.
  await page.click("#uploadBtn");
  await opened(2);
  await page.waitForFunction(() => document.getElementById("libCount")?.textContent === "library(1)");

  expect(await page.locator(".card").count()).toBe(1);
  expect(await page.locator("#libCount").textContent()).toBe("library(1)");
  expect(uploads).toBe(2);

  await page.close();
}, 30_000);

test.skipIf(!browser)("ignores a second Upload click while one request is pending", async () => {
  const page = await openPage();
  const uploaded = { ...paper, id: "solo-1", title: "Solo Paper", source: "upload" };
  let pending: Route | null = null;
  let uploads = 0;

  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/upload", (route) => {
    uploads++;
    pending = route;
  });
  await page.route("**/api/library", (route) =>
    route.request().method() === "GET"
      ? route.fulfill(jsonBody(200, { papers: [uploaded] }))
      : route.continue(),
  );
  await page.goto(server.url);
  await page.setInputFiles("#file", pdfFile(["solo page"]));

  const firstRequest = page.waitForRequest((r) => r.url().endsWith("/api/upload"));
  await page.click("#uploadBtn");
  await firstRequest;
  await until(page, () => pending !== null);
  await page.waitForFunction(() => document.getElementById("uploadBtn")?.hasAttribute("disabled"));

  // A disabled button ignores .click(); dispatchEvent forces the listener and the
  // handler's `S.upload.state === "uploading"` guard must still swallow it.
  await page.evaluate(() => {
    document.getElementById("uploadBtn")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.locator("#uploadBtn").click({ force: true });
  await page.waitForTimeout(300);

  expect(uploads).toBe(1);
  expect(pending).not.toBeNull();

  await pending!.fulfill(jsonBody(201, { paper: uploaded, queue: { active: 0, queued: 0, concurrency: 1 } }));
  await page.waitForFunction(() => document.getElementById("uploadBtn")?.hasAttribute("disabled") === false);
  await page.waitForFunction(() => document.getElementById("paperInfo")?.textContent?.includes("Solo Paper"));

  expect(uploads).toBe(1);
  expect(await page.locator("#uploadBtn").isEnabled()).toBe(true);
  expect(await page.locator("#queueInfo").textContent()).toBe("parse 0/1");

  await page.close();
}, 30_000);
