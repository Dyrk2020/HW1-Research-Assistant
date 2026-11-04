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
  title: "E2E Paper",
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

beforeAll(async () => {
  server = await startServer();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

test.skipIf(!browser)("renders the three-pane shell", async () => {
  const page = await openPage();
  await page.route("**/api/search**", emptySearch);
  await page.goto(server.url);

  expect(await page.title()).toBe("HW1 Research Assistant");
  expect(await page.locator("#panePick").isVisible()).toBe(true);
  expect(await page.locator("#paneChat").isVisible()).toBe(true);
  expect(await page.locator("#panePdf").isVisible()).toBe(true);

  await page.close();
}, 30_000);

test.skipIf(!browser)("renders the clicked search's results", async () => {
  const page = await openPage();
  await page.route("**/api/search**", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    return route.fulfill(q === "agents" ? bundle([paper, { ...paper, id: "e2", title: "Second Paper" }]) : bundle([]));
  });
  await page.goto(server.url);
  await page.fill("#q", "agents");
  const request = page.waitForRequest((r) => r.url().includes("/api/search?q=agents"));
  await page.click("#searchBtn");
  await request;
  await page.waitForSelector(".card");

  expect(await page.locator(".card").count()).toBe(2);
  expect(await page.locator(".card h4").first().textContent()).toBe("E2E Paper");

  await page.close();
}, 30_000);

test.skipIf(!browser)("library tab loads saved papers", async () => {
  const page = await openPage();
  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/library", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ papers: [paper] }) })
      : route.continue(),
  );
  await page.goto(server.url);
  await page.click("#tabLib");
  await page.waitForSelector(".card");

  expect(await page.locator("#libCount").textContent()).toBe("library(1)");
  expect(await page.locator(".card h4").first().textContent()).toBe("E2E Paper");

  await page.close();
}, 30_000);

test.skipIf(!browser)("saving a card sends the paper and flips the button", async () => {
  const page = await openPage();
  await page.route("**/api/search**", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    return route.fulfill(q === "agents" ? bundle([paper]) : bundle([]));
  });
  await page.route("**/api/library", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as { id?: string; title?: string };
    if (!body?.id || !body?.title) return route.fulfill({ status: 400, body: "bad payload" });
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ paper: body }) });
  });
  await page.goto(server.url);
  await page.fill("#q", "agents");
  await page.click("#searchBtn");
  await page.waitForSelector(".card");

  const save = page.locator(".card .row button").nth(1);
  await save.click();
  await page.waitForFunction(() => document.querySelector(".card .row button:nth-child(2)")?.textContent === "Saved");

  expect(await save.textContent()).toBe("Saved");

  await page.close();
}, 30_000);

test.skipIf(!browser)("upload flow selects the new paper", async () => {
  const page = await openPage();
  const uploaded = { ...paper, id: "up1", title: "Uploaded Paper", source: "upload", link: "https://example.com/u" };
  let uploadMethod = "";
  let uploadType = "";
  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/upload", (route) => {
    uploadMethod = route.request().method();
    uploadType = route.request().headers()["content-type"] ?? "";
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ paper: uploaded, queue: { active: 0, queued: 0, concurrency: 1 } }),
    });
  });
  await page.route("**/api/library", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ papers: [uploaded] }) })
      : route.continue(),
  );
  await page.goto(server.url);
  await page.setInputFiles("#file", {
    name: "fixture.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(makePdf({ pages: ["hello"] })),
  });
  await page.click("#uploadBtn");
  await page.waitForFunction(() => document.getElementById("paperInfo")?.textContent?.includes("Uploaded Paper"));
  await page.waitForFunction(() => document.getElementById("libCount")?.textContent === "library(1)");

  expect(uploadMethod).toBe("POST");
  expect(uploadType).toContain("multipart/form-data");
  expect(await page.locator("#libCount").textContent()).toBe("library(1)");
  expect(await page.locator("#msgs").textContent()).toContain("Opened");

  await page.close();
}, 30_000);

test.skipIf(!browser)("fetch flow selects the fetched paper", async () => {
  const page = await openPage();
  const fetched = { ...paper, id: "f1", title: "Fetched Paper", source: "fetch", link: "https://example.com/f.pdf" };
  let fetchBody: { url?: string } = {};
  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/fetch", (route) => {
    fetchBody = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ paper: fetched, queue: { active: 0, queued: 0, concurrency: 1 }, metaMiss: false }),
    });
  });
  await page.route("**/api/library", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ papers: [fetched] }) })
      : route.continue(),
  );
  await page.goto(server.url);
  await page.fill("#fetchUrl", "https://example.com/f.pdf");
  await page.click("#fetchBtn");
  await page.waitForFunction(() => document.getElementById("paperInfo")?.textContent?.includes("Fetched Paper"));
  await page.waitForFunction(() => document.getElementById("libCount")?.textContent === "library(1)");

  expect(fetchBody.url).toBe("https://example.com/f.pdf");
  expect(await page.locator("#libCount").textContent()).toBe("library(1)");

  await page.close();
}, 30_000);

test.skipIf(!browser)("shows an empty library state", async () => {
  const page = await openPage();
  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/library", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ papers: [] }) }),
  );
  await page.goto(server.url);
  await page.click("#tabLib");
  await page.waitForFunction(() => document.getElementById("libCount")?.textContent === "library(0)");

  expect(await page.locator(".card").count()).toBe(0);
  await page.close();
}, 30_000);

test.skipIf(!browser)("deletes a library paper and updates the count", async () => {
  const created = { ...paper, id: "e2e-delete", title: "Delete Me" };
  const res = await fetch(server.url + "/api/library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(created),
  });
  expect(res.status).toBe(201);

  const page = await openPage();
  await page.route("**/api/search**", emptySearch);
  await page.goto(server.url);
  await page.click("#tabLib");
  await page.waitForSelector(".card");
  const card = page.locator(".card", { hasText: "Delete Me" });
  await card.locator("button", { hasText: "Delete" }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll(".card")].some((c) => c.textContent?.includes("Delete Me")));

  expect(await page.locator(".card", { hasText: "Delete Me" }).count()).toBe(0);
  await page.close();
}, 30_000);

test.skipIf(!browser)("shows the external-link overlay for a paper without a PDF", async () => {
  const page = await openPage();
  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/library", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ papers: [paper] }) }),
  );
  await page.goto(server.url);
  await page.click("#tabLib");
  await page.waitForSelector(".card");
  await page.click(".card button.primary");

  await page.waitForFunction(() => document.getElementById("pdfOverlay")?.textContent?.includes("Preview blocked"));
  expect(await page.locator("#pdfOverlay").textContent()).toContain("Preview blocked");
  expect(await page.locator("#pdfOpen").isDisabled()).toBe(true);
  expect(await page.locator("#msgs").textContent()).toContain("external link");
  await page.close();
}, 30_000);

test.skipIf(!browser)("opens the settings panel without exposing key values", async () => {
  const page = await openPage();
  await page.route("**/api/search**", emptySearch);
  await page.goto(server.url);
  await page.click("#keyBtn");
  await page.waitForFunction(() => document.getElementById("keyStatus")?.textContent?.includes("llm:"));

  expect(await page.locator("#keyPanel").isVisible()).toBe(true);
  expect(await page.locator("#keyStatus").textContent()).toContain("exa:");
  expect(await page.locator("#kLlm").getAttribute("type")).toBe("password");
  expect(await page.locator("#kExa").getAttribute("type")).toBe("password");
  await page.close();
}, 30_000);

test.skipIf(!browser)("toggles focus mode with the keyboard escape", async () => {
  const page = await openPage();
  await page.route("**/api/search**", emptySearch);
  await page.goto(server.url);
  await page.click("#pdfFocus");
  expect(await page.locator("body").evaluate((el) => el.classList.contains("focus-pdf"))).toBe(true);

  await page.keyboard.press("Escape");
  expect(await page.locator("body").evaluate((el) => el.classList.contains("focus-pdf"))).toBe(false);
  await page.close();
}, 30_000);

test.skipIf(!browser)("uploads a PDF through the real UI and library", async () => {
  const page = await openPage();
  await page.route("**/api/search**", emptySearch);
  await page.goto(server.url);
  await page.setInputFiles("#file", {
    name: "full-stack.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(makePdf({ pages: ["full stack upload"] })),
  });
  await page.click("#uploadBtn");
  await page.waitForFunction(() => document.getElementById("libCount")?.textContent !== "library(0)");
  await page.waitForSelector(".card");

  expect(await page.locator("#msgs").textContent()).toContain("Opened");
  expect(await page.locator(".card").count()).toBeGreaterThan(0);
  await page.close();
}, 45_000);

test.skipIf(!browser)("streams a cited answer into the chat pane", async () => {
  const page = await openPage();
  const libraryPaper = { ...paper, pageCount: 2 };
  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/library", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ papers: [libraryPaper] }) })
      : route.continue(),
  );
  let askQuery = "";
  let askId = "";
  await page.route("**/api/ask**", (route) => {
    const u = new URL(route.request().url());
    askQuery = u.searchParams.get("q") ?? "";
    askId = u.searchParams.get("id") ?? "";
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        'data: {"text":"First answer [p.1]"}\n\n' +
        'data: {"text":" second answer [p.2]"}\n\n' +
        "data: [DONE]\n\n",
    });
  });
  await page.goto(server.url);
  await page.click("#tabLib");
  await page.waitForSelector(".card");
  await page.click(".card button.primary");
  await page.fill("#askq", "What is it?");
  await page.click("#askBtn");

  await page.waitForFunction(() => {
    const bubbles = [...document.querySelectorAll(".msg.model")];
    return bubbles.some((b) => b.textContent?.includes("second answer [p.2]"));
  });
  expect(askQuery).toBe("What is it?");
  expect(askId).toBe("e1");
  const answer = page.locator(".msg.model").last();
  expect(await answer.textContent()).toContain("First answer [p.1]");
  expect(await answer.locator(".cite").count()).toBe(2);
  expect(await page.locator("#askBtn").isEnabled()).toBe(true);

  await page.close();
}, 30_000);

test.skipIf(!browser)("renders an uploaded PDF in the pdfrx pane", async () => {
  const pdf = makePdf({ pages: ["PDF page one", "PDF page two"] });
  const form = new FormData();
  form.append("file", new File([pdf], "fixture.pdf", { type: "application/pdf" }));
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
  expect(await page.locator("#pageInfo").textContent()).toContain("1 / 2");

  await page.close();
}, 60_000);

test.skipIf(!browser)("surfaces a search failure in the error bar", async () => {
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

  await page.close();
}, 30_000);
