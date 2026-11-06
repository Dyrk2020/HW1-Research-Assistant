// Settings preview, keyboard shortcuts, and accessibility basics.
// The settings panel only *previews* .env text locally — nothing is persisted,
// so these tests assert the preview and the absence of any settings write.
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

const settingsPayload = {
  llm: { model: "deepseek/deepseek-v4.1-flash", baseUrl: "http://127.0.0.1:8787/v1", mode: "proxy" },
  exa: { mode: "keyless" },
};

const emptySearch = (route: Route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ papers: [], warnings: [], sourceStatus: [] }),
  });

const mockBackend = async (page: Page) => {
  await page.route("**/api/search**", emptySearch);
  await page.route("**/api/library", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ papers: [] }) }),
  );
  await page.route("**/api/settings", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(settingsPayload) }),
  );
};

declare global {
  interface Window {
    /** Probe flag: set by a capture listener when a Meta+K keydown arrives. */
    __metaKSeen?: boolean;
  }
}

const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? null);

beforeAll(async () => {
  server = await startServer();
}, 60_000);

afterAll(async () => {
  // Stop the server first: a wedged browser close must not orphan the listener.
  const stopServer = server?.stop();
  await browser?.close().catch(() => {});
  await stopServer;
}, 30_000);

test.skipIf(!browser)("previews .env lines locally without writing settings", async () => {
  const page = await openPage();
  await mockBackend(page);

  // Count every settings request the page makes, before anything is typed.
  const settingsCalls: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/settings") settingsCalls.push(request.method());
  });

  await page.goto(server.url);
  await page.click("#keyBtn");
  await page.waitForFunction(() => document.getElementById("keyStatus")?.textContent?.includes("exa:"));
  expect(await page.locator("#keyPanel").isVisible()).toBe(true);

  await page.fill("#kBase", "http://127.0.0.1:8123/v1");
  await page.fill("#kModel", "acme/test-model");
  await page.fill("#kLlm", "sk-test-llm");
  await page.fill("#kExa", "exa-test-key");

  const callsBeforeSave = settingsCalls.length;
  await page.click("#kSave");

  const expected = [
    "LLM_BASE_URL=http://127.0.0.1:8123/v1",
    "LLM_MODEL=acme/test-model",
    "LLM_API_KEY=sk-test-llm",
    "EXA_API_KEY=exa-test-key",
  ];
  await page.waitForFunction(
    (lines) => {
      const text = document.getElementById("kOut")?.textContent ?? "";
      return lines.every((line) => text.includes(line));
    },
    expected,
  );

  const out = (await page.locator("#kOut").textContent()) ?? "";
  for (const line of expected) expect(out).toContain(line);
  expect(await page.locator("#kOut").isVisible()).toBe(true);

  // Secret inputs are wiped after the preview; non-secret prefs survive.
  expect(await page.locator("#kLlm").inputValue()).toBe("");
  expect(await page.locator("#kExa").inputValue()).toBe("");
  expect(await page.locator("#kBase").inputValue()).toBe("http://127.0.0.1:8123/v1");

  // Preview only: no settings request is emitted by saving, and any settings
  // traffic that did happen (opening Keys refreshes status) is read-only.
  expect(settingsCalls.length).toBe(callsBeforeSave);
  expect(settingsCalls.length).toBeGreaterThan(0);
  expect(settingsCalls.every((method) => method === "GET")).toBe(true);

  await page.close();
}, 30_000);

test.skipIf(!browser)("Control+K and Meta+K focus the search box; Escape leaves focus-pdf", async () => {
  const page = await openPage();
  await mockBackend(page);
  await page.goto(server.url);

  // Start from the chat composer so focus has to move.
  await page.evaluate(() => document.getElementById("askq")!.focus());
  await page.keyboard.press("Control+k");
  await page.waitForFunction(() => document.activeElement?.id === "q");
  expect(await activeId(page)).toBe("q");

  // Meta+K is handled by the same listener, but only assert it when the
  // browser actually delivers the Meta modifier (platform-dependent).
  await page.evaluate(() => {
    window.__metaKSeen = false;
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key.toLowerCase() === "k" && e.metaKey) window.__metaKSeen = true;
      },
      true,
    );
    document.getElementById("askq")!.focus();
  });
  await page.keyboard.press("Meta+k");
  const metaDelivered = await page.evaluate(() => Boolean(window.__metaKSeen));
  if (metaDelivered) {
    await page.waitForFunction(() => document.activeElement?.id === "q");
    expect(await activeId(page)).toBe("q");
  }

  await page.click("#pdfFocus");
  expect(await page.locator("body").evaluate((el) => el.classList.contains("focus-pdf"))).toBe(true);

  await page.keyboard.press("Escape");
  expect(await page.locator("body").evaluate((el) => el.classList.contains("focus-pdf"))).toBe(false);

  await page.close();
}, 30_000);

test.skipIf(!browser)("exposes alert and selected-tab semantics and keyboard focus", async () => {
  const page = await openPage();
  await page.route("**/api/search**", (route) => route.fulfill({ status: 500, contentType: "text/plain", body: "boom" }));
  await page.route("**/api/library", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ papers: [] }) }),
  );
  await page.route("**/api/settings", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(settingsPayload) }),
  );
  await page.goto(server.url);

  // The error surface is a live region announced as an alert.
  const errbar = page.locator("#errbar");
  expect(await errbar.getAttribute("role")).toBe("alert");
  await page.click("#searchBtn");
  await page.waitForFunction(() => {
    const el = document.getElementById("errbar");
    return Boolean(el && el.textContent && getComputedStyle(el).display !== "none");
  });
  expect(await errbar.textContent()).toContain("search failed");

  // Tabs publish their selected state and actually swap pane contents.
  expect(await page.locator("#tabSearch").getAttribute("aria-selected")).toBe("true");
  expect(await page.locator("#tabLib").getAttribute("aria-selected")).toBe("false");

  await page.click("#tabLib");
  await page.waitForFunction(() => document.getElementById("tabLib")?.getAttribute("aria-selected") === "true");
  expect(await page.locator("#tabLib").getAttribute("aria-selected")).toBe("true");
  expect(await page.locator("#tabSearch").getAttribute("aria-selected")).toBe("false");
  expect(await page.locator("#searchBox").isVisible()).toBe(false);
  await page.waitForFunction(() => document.getElementById("libCount")?.textContent === "library(0)");
  expect(await page.locator("#libCount").textContent()).toBe("library(0)");

  await page.click("#tabSearch");
  await page.waitForFunction(() => document.getElementById("tabSearch")?.getAttribute("aria-selected") === "true");
  expect(await page.locator("#tabSearch").getAttribute("aria-selected")).toBe("true");
  expect(await page.locator("#tabLib").getAttribute("aria-selected")).toBe("false");
  expect(await page.locator("#searchBox").isVisible()).toBe(true);

  // Focus visibility cannot be asserted visually, but focus order can.
  await page.locator("#q").focus();
  expect(await activeId(page)).toBe("q");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => document.activeElement?.id === "searchBtn");
  expect(await activeId(page)).toBe("searchBtn");

  await page.close();
}, 30_000);

if (browser) {
  // Known gap: at 600px wide the fixed 300px picker plus the panes overflow
  // horizontally (scrollWidth > innerWidth). Pin it so a fix flips this test.
  test.failing("pins narrow-viewport horizontal overflow at 600x900", async () => {
    const page = await openPage();
    await mockBackend(page);
    await page.setViewportSize({ width: 600, height: 900 });
    await page.goto(server.url);
    await page.waitForFunction(() => document.readyState === "complete");

    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
    }));

    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    await page.close();
  }, 30_000);
} else {
  test.skip("pins narrow-viewport horizontal overflow at 600x900", () => {});
}
