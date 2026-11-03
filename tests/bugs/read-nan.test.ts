import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "../helpers/server.ts";

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.stop();
});

const seed = (over: Record<string, unknown> = {}) =>
  fetch(server.url + "/api/library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "nanp",
      title: "NaN Cursor Paper",
      authors: [],
      year: null,
      abstract: "abcdefghij",
      link: "",
      source: "test",
      pdfPath: null,
      ...over,
    }),
  });

test.failing("BUG: non-numeric limit yields a null end and empty text", async () => {
  await seed();
  const data = await (await fetch(server.url + "/api/read?id=nanp&limit=abc")).json();

  expect(Number.isFinite(data.end)).toBe(true);
  expect(data.text.length).toBeGreaterThan(0);
});
