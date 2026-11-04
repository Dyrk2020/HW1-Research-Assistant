import { afterEach, describe, expect, test } from "bun:test";
import { handleRequest } from "../../server.ts";
import { savePaper } from "../../lib/db.ts";

const api = (path: string, init?: RequestInit) => handleRequest(new Request("http://test.local" + path, init));

const save = (over: Record<string, unknown>) =>
  savePaper({
    id: "edge-read",
    title: "Edge Paper",
    authors: [],
    year: null,
    abstract: "0123456789",
    link: "",
    source: "test",
    pdfPath: null,
    ...over,
  });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("static assets and methods", () => {
  test("serves index.html with an HTML content type", async () => {
    const res = await api("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>HW1 Research Assistant</title>");
  });

  test("serves the explicit /index.html alias", async () => {
    expect((await api("/index.html")).status).toBe(200);
  });

  test("marks PDFium assets immutable", async () => {
    const wasm = await api("/pdfium/pdfium.wasm");
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect(wasm.headers.get("cache-control")).toContain("immutable");

    const worker = await api("/pdfium/pdfium_worker.js");
    expect(worker.headers.get("content-type")).toBe("text/javascript");
  });

  test("serves pdfrx ESM and rejects double slashes", async () => {
    const res = await api("/pdfrx/viewer/dist/index.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect((await api("/pdfrx/a//b.js")).status).toBe(400);
  });

  test("does not treat an unsupported method as a route", async () => {
    expect((await api("/api/library", { method: "PUT" })).status).toBe(404);
    expect((await api("/api/search", { method: "POST" })).status).toBe(404);
  });
});

describe("library and read boundaries", () => {
  test("deleting a missing id is idempotent", async () => {
    const res = await api("/api/library/edge-missing", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("clamps a negative offset to zero", async () => {
    save({ id: "edge-read", abstract: "0123456789" });
    const data = await (await api("/api/read?id=edge-read&offset=-5&limit=4")).json();
    expect(data.offset).toBe(0);
    expect(data.text).toBe("0123");
    expect(data.end).toBe(4);
  });

  test("clamps a huge limit to the 20000 cap", async () => {
    const text = "x".repeat(25_000);
    save({ id: "edge-long", abstract: text });
    const data = await (await api("/api/read?id=edge-long&limit=999999")).json();
    expect(data.text.length).toBe(20_000);
    expect(data.end).toBe(20_000);
    expect(data.nextOffset).toBe(20_000);
  });

  test("returns an empty final window past the end", async () => {
    save({ id: "edge-short", abstract: "abc" });
    const data = await (await api("/api/read?id=edge-short&offset=99&limit=10")).json();
    expect(data.text).toBe("");
    expect(data.end).toBe(3);
    expect(data.nextOffset).toBeNull();
    expect(data.endOfDocument).toBe(true);
  });

  test("percent-decodes the id before lookup", async () => {
    save({ id: "edge decode", abstract: "abc" });
    const res = await api("/api/read?id=edge%20decode");
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("edge decode");
  });
});

describe("PDF serving and SSE fallbacks", () => {
  test("404s for a paper without a pdfPath", async () => {
    save({ id: "edge-nopdf", pdfPath: null });
    expect((await api("/api/pdf/edge-nopdf")).status).toBe(404);
  });

  test("404s for summarize of an unknown paper", async () => {
    expect((await api("/api/summarize?id=edge-none")).status).toBe(404);
  });

  test("falls back to the mock when the LLM returns 500", async () => {
    save({ id: "edge-sse", title: "SSE Edge", abstract: "sse abstract" });
    globalThis.fetch = (async () => new Response("upstream down", { status: 500 })) as typeof fetch;

    const res = await api("/api/summarize?id=edge-sse");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const body = await res.text();
    expect(body).toContain("[DONE]");
    expect(body).toContain("mock");
  });
});

describe("fetch and upload input validation", () => {
  test("rejects a missing fetch URL", async () => {
    const res = await api("/api/fetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("blocked");
  });

  test("rejects a non-http fetch scheme", async () => {
    const res = await api("/api/fetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "ftp://example.com/x.pdf" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects multipart upload without a file", async () => {
    const res = await api("/api/upload", { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("file required");
  });

  test("rejects an upload whose field is not named file", async () => {
    const fd = new FormData();
    fd.append("pdf", new File([new Uint8Array([1, 2, 3])], "x.pdf", { type: "application/pdf" }));
    const res = await api("/api/upload", { method: "POST", body: fd });
    expect(res.status).toBe(400);
  });
});

describe("settings modes", () => {
  test("reports proxy/keyless modes when env keys are absent", async () => {
    const llm = process.env.LLM_API_KEY;
    const exa = process.env.EXA_API_KEY;
    delete process.env.LLM_API_KEY;
    delete process.env.EXA_API_KEY;
    try {
      const data = await (await api("/api/settings")).json();
      expect(data.llm).toMatchObject({ keySet: false, mode: "proxy-managed" });
      expect(data.exa).toMatchObject({ keySet: false, mode: "keyless-mcp" });
    } finally {
      if (llm !== undefined) process.env.LLM_API_KEY = llm;
      if (exa !== undefined) process.env.EXA_API_KEY = exa;
    }
  });

  test("reports full-api mode when an Exa key is set", async () => {
    const old = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa-test";
    try {
      const data = await (await api("/api/settings")).json();
      expect(data.exa).toMatchObject({ keySet: true, mode: "full-api" });
      expect(JSON.stringify(data)).not.toContain("exa-test");
    } finally {
      if (old === undefined) delete process.env.EXA_API_KEY;
      else process.env.EXA_API_KEY = old;
    }
  });
});
