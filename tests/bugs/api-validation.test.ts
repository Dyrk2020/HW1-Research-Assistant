import { expect, test } from "bun:test";
import { handleRequest } from "../../server.ts";

const post = (path: string, body: string) =>
  handleRequest(
    new Request("http://test.local" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );

test.failing("BUG: missing-field library body returns 500 instead of 400", async () => {
  const res = await post("/api/library", "{}");
  expect(res.status).toBe(400);
});

test.failing("BUG: malformed percent-encoding in a DELETE id crashes the handler", async () => {
  const res = await handleRequest(new Request("http://test.local/api/library/%", { method: "DELETE" }));
  expect(res.status).toBe(400);
});

test.failing("BUG: /api/upload accepts a non-PDF payload as a paper", async () => {
  const fd = new FormData();
  fd.append("file", new File([new TextEncoder().encode("not a pdf")], "notes.txt", { type: "text/plain" }));
  const res = await handleRequest(new Request("http://test.local/api/upload", { method: "POST", body: fd }));
  expect(res.status).toBe(415);
});

test.failing("BUG: /api/fetch accepts a non-PDF body when the URL ends in .pdf", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "9" } });
    return new Response("not a pdf", { status: 200, headers: { "content-type": "application/pdf" } });
  }) as typeof fetch;
  try {
    const res = await handleRequest(
      new Request("http://test.local/api/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/fake.pdf" }),
      }),
    );
    expect(res.status).toBe(415);
  } finally {
    globalThis.fetch = realFetch;
  }
});
