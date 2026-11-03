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
