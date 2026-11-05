import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { startServer, type TestServer } from "../helpers/server.ts";

let server: TestServer;
let browser: Browser;

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

beforeAll(async () => {
  server = await startServer();
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

test("renders the three-pane shell", async () => {
  const page = await browser.newPage();
  await page.route("**/api/search**", (route) => route.fulfill(bundle([])));
  await page.goto(server.url);

  expect(await page.title()).toBe("HW1 Research Assistant");
  expect(await page.locator("#panePick").isVisible()).toBe(true);
  expect(await page.locator("#paneChat").isVisible()).toBe(true);
  expect(await page.locator("#panePdf").isVisible()).toBe(true);

  await page.close();
}, 30_000);

test("renders search results as cards", async () => {
  const page = await browser.newPage();
  await page.route("**/api/search**", (route) =>
    route.fulfill(bundle([paper, { ...paper, id: "e2", title: "Second Paper" }])),
  );
  await page.goto(server.url);
  await page.fill("#q", "agents");
  await page.click("#searchBtn");
  await page.waitForSelector(".card");

  expect(await page.locator(".card").count()).toBe(2);
  expect(await page.locator(".card h4").first().textContent()).toBe("E2E Paper");

  await page.close();
}, 30_000);

test("library tab loads saved papers", async () => {
  const page = await browser.newPage();
  await page.route("**/api/search**", (route) => route.fulfill(bundle([])));
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

test("saving a card flips the button to Saved", async () => {
  const page = await browser.newPage();
  await page.route("**/api/search**", (route) => route.fulfill(bundle([paper])));
  await page.route("**/api/library", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ paper }) })
      : route.continue(),
  );
  await page.goto(server.url);
  await page.waitForSelector(".card");

  const save = page.locator(".card .row button").nth(1);
  await save.click();
  await page.waitForFunction(() => document.querySelector(".card .row button:nth-child(2)")?.textContent === "Saved");

  expect(await save.textContent()).toBe("Saved");

  await page.close();
}, 30_000);

test("surfaces a search failure in the error bar", async () => {
  const page = await browser.newPage();
  await page.route("**/api/search**", (route) => route.fulfill({ status: 500, body: "boom" }));
  await page.goto(server.url);
  await page.click("#searchBtn");
  await page.waitForFunction(() => document.getElementById("errbar")?.style.display === "block");

  expect(await page.locator("#errbar").textContent()).toContain("search failed");

  await page.close();
}, 30_000);
