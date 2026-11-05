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
  title: "Edge Paper",
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

beforeAll(async () => {
  server = await startServer();
}, 60_000);

afterAll(async () => {
  // Stop the server first: a wedged browser close must not orphan the listener.
  const stopServer = server?.stop();
  await browser?.close().catch(() => {});
  await stopServer;
}, 30_000);

test.skipIf(!browser)("clears a failed search after a later search succeeds", async () => {
  const page = await openPage();
  await page.route("**/api/search**", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    return q === "boom" ? route.fulfill({ status: 500, body: "boom" }) : route.fulfill(bundle([]));
  });
  await page.goto(server.url);
  expect(await page.locator("#errbar").isVisible()).toBe(false);

  await page.fill("#q", "boom");
  await page.click("#searchBtn");
  await page.waitForFunction(() => document.getElementById("errbar")?.style.display === "block");

  expect(await page.locator("#errbar").textContent()).toContain("search failed");
  expect(await page.locator("#src").textContent()).toBe("search failed");
  expect(await page.locator(".card").count()).toBe(0);

  // A later successful (empty) search must clear both the bar and the error status.
  await page.fill("#q", "quiet");
  const ok = page.waitForResponse((r) => r.url().includes("/api/search?q=quiet") && r.status() === 200);
  await page.click("#searchBtn");
  await ok;
  await page.waitForFunction(() => document.getElementById("errbar")?.style.display === "none");

  expect(await page.locator("#errbar").textContent()).toBe("");
  expect(await page.locator("#src").textContent()).toBe("");
  expect(await page.locator("#results").textContent()).toBe("no results");
  expect(await page.locator(".card").count()).toBe(0);

  await page.close();
}, 30_000);

test.skipIf(!browser)("keeps the picker unchanged when upload is rejected as non-PDF", async () => {
  const page = await openPage();
  let uploadContentType = "";
  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/upload", (route) => {
    uploadContentType = route.request().headers()["content-type"] ?? "";
    return route.fulfill(jsonBody(415, { error: "not a PDF (text/html)" }));
  });
  await page.goto(server.url);
  expect(await page.locator("#results").textContent()).toBe("no results");

  await page.setInputFiles("#file", {
    name: "not-a-pdf.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("plain text, not a pdf"),
  });
  await page.click("#uploadBtn");
  await page.waitForFunction(() => document.getElementById("errbar")?.style.display === "block");

  expect(uploadContentType).toContain("multipart/form-data");
  expect(await page.locator("#errbar").textContent()).toBe("upload failed: 415");
  expect(await page.locator("#uploadBtn").isEnabled()).toBe(true);
  // No paper was selected, no library switch, no new card, no queue update.
  expect(await page.locator("#results").textContent()).toBe("no results");
  expect(await page.locator(".card").count()).toBe(0);
  expect(await page.locator("#tabSearch").getAttribute("aria-selected")).toBe("true");
  expect(await page.locator("#queueInfo").textContent()).toBe("");
  expect(await page.locator("#paperInfo").textContent()).toContain("Select a paper");

  await page.close();
}, 30_000);

test.skipIf(!browser)("reports a blocked fetch and adds no card", async () => {
  const page = await openPage();
  let sentUrl = "";
  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/fetch", (route) => {
    const payload: unknown = route.request().postDataJSON();
    if (payload && typeof payload === "object" && "url" in payload && typeof payload.url === "string") {
      sentUrl = payload.url;
    }
    return route.fulfill(jsonBody(400, { error: "blocked: non-public URL" }));
  });
  await page.goto(server.url);

  await page.fill("#fetchUrl", "http://127.0.0.1/secret.pdf");
  await page.click("#fetchBtn");
  await page.waitForFunction(() => document.getElementById("errbar")?.style.display === "block");

  expect(sentUrl).toBe("http://127.0.0.1/secret.pdf");
  expect(await page.locator("#errbar").textContent()).toBe("fetch failed: blocked: non-public URL");
  expect(await page.locator("#fetchBtn").isEnabled()).toBe(true);
  expect(await page.locator("#results").textContent()).toBe("no results");
  expect(await page.locator(".card").count()).toBe(0);
  expect(await page.locator("#tabSearch").getAttribute("aria-selected")).toBe("true");
  expect(await page.locator("#paperInfo").textContent()).toContain("Select a paper");

  await page.close();
}, 30_000);

test.skipIf(!browser)("keeps the card and re-enables Delete when deletion fails", async () => {
  const page = await openPage();
  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/library", (route) =>
    route.request().method() === "GET"
      ? route.fulfill(jsonBody(200, { papers: [paper] }))
      : route.continue(),
  );
  await page.route("**/api/library/e1", (route) =>
    route.request().method() === "DELETE" ? route.fulfill({ status: 500, body: "nope" }) : route.continue(),
  );
  await page.goto(server.url);
  await page.click("#tabLib");
  await page.waitForSelector(".card");
  await page.waitForFunction(() => document.getElementById("libCount")?.textContent === "library(1)");

  const card = page.locator(".card", { hasText: "Edge Paper" });
  const del = card.locator("button", { hasText: "Delete" });
  await del.click();
  await page.waitForFunction(() => document.getElementById("errbar")?.style.display === "block");

  expect(await page.locator("#errbar").textContent()).toBe("delete failed: 500");
  expect(await page.locator(".card").count()).toBe(1);
  expect(await page.locator("#libCount").textContent()).toBe("library(1)");
  expect(await del.isEnabled()).toBe(true);
  expect(await del.textContent()).toBe("Delete");

  await page.close();
}, 30_000);

test.skipIf(!browser)("shows key-present settings without exposing values", async () => {
  const page = await openPage();
  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/settings", (route) =>
    route.fulfill(
      jsonBody(200, {
        llm: { baseUrl: "http://127.0.0.1:9/v1", model: "acme/edge-model", mode: "custom-key" },
        exa: { keySet: true, mode: "full-api" },
      }),
    ),
  );
  await page.goto(server.url);
  await page.waitForFunction(() => document.getElementById("keyStatus")?.textContent?.includes("custom-key"));

  expect(await page.locator("#keyStatus").textContent()).toBe("llm: edge-model (custom-key) · exa: full-api");
  expect(await page.locator("#keyStatus").getAttribute("title")).toBe("acme/edge-model via http://127.0.0.1:9/v1");

  await page.click("#keyBtn");
  expect(await page.locator("#keyPanel").isVisible()).toBe(true);
  expect(await page.locator("#kBase").inputValue()).toBe("");
  expect(await page.locator("#kBase").getAttribute("placeholder")).toBe("http://127.0.0.1:9/v1");
  expect(await page.locator("#kModel").getAttribute("placeholder")).toBe("acme/edge-model");
  // Values are never prefilled from server state.
  expect(await page.locator("#kLlm").inputValue()).toBe("");
  expect(await page.locator("#kExa").inputValue()).toBe("");

  await page.close();
}, 30_000);

test.skipIf(!browser)("surfaces an SSE failure and restores the composer", async () => {
  const page = await openPage();
  let askUrl = "";
  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/library", (route) =>
    route.request().method() === "GET"
      ? route.fulfill(jsonBody(200, { papers: [{ ...paper, pageCount: 2 }] }))
      : route.continue(),
  );
  await page.route("**/api/ask**", (route) => {
    askUrl = route.request().url();
    return route.fulfill(jsonBody(404, { error: "not found" }));
  });
  await page.goto(server.url);
  await page.click("#tabLib");
  await page.waitForSelector(".card");
  await page.click(".card button.primary");
  await page.waitForFunction(() => document.getElementById("pdfOverlay")?.textContent?.includes("Preview blocked"));

  await page.fill("#askq", "What is it?");
  await page.click("#askBtn");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".msg.model")].some((b) => b.textContent?.includes("No answer")),
  );

  const ask = new URL(askUrl);
  expect(ask.pathname).toBe("/api/ask");
  expect(ask.searchParams.get("id")).toBe("e1");
  expect(ask.searchParams.get("q")).toBe("What is it?");
  const last = page.locator(".msg.model").last();
  expect(await last.textContent()).toBe("No answer — paper not found on server (try Save first, or re-open).");
  expect(await last.locator(".cite").count()).toBe(0);
  expect(await page.locator("#askBtn").isEnabled()).toBe(true);
  expect(await page.locator("#stopBtn").isDisabled()).toBe(true);
  expect(await page.locator(".msg.model.streaming").count()).toBe(0);

  await page.close();
}, 30_000);
