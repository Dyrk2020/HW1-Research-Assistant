import { deletePaper, getPaper, listPapers, savePaper } from "./lib/db.ts";
import { getSeenPaper, lookupArxiv, searchPapers } from "./lib/search.ts";
import { probePdf } from "./lib/pdf.ts";
import { MAX_DOWNLOAD_MB, isPublicHttpUrl } from "./lib/safety.ts";
import { pdfToMarkdown } from "@oh-my-pi/pi-natives";
import { mkdir } from "node:fs/promises";
const PORT = Number(process.env.PORT ?? 4321);
const PAPERS_DIR = `${import.meta.dir}/papers`;
await mkdir(PAPERS_DIR, { recursive: true });

// Upload worker pool: cap concurrent native parses, queue the rest (sequential drain)
const UPLOAD_CONCURRENCY = Math.max(1, Number(process.env.UPLOAD_CONCURRENCY ?? 2));
let uploadActive = 0;
const uploadQueue: (() => void)[] = [];

function uploadStatus(): { active: number; queued: number; concurrency: number } {
  return { active: uploadActive, queued: uploadQueue.length, concurrency: UPLOAD_CONCURRENCY };
}

function runUpload<T>(job: () => Promise<T>): Promise<T> {
  if (uploadActive < UPLOAD_CONCURRENCY) {
    uploadActive++;
    return job().finally(() => {
      uploadActive--;
      const next = uploadQueue.shift();
      if (next) {
        uploadActive++;
        next();
      }
    }) as Promise<T>;
  }
  return new Promise<T>((resolve, reject) => {
    uploadQueue.push(() => {
      job().then(resolve, reject).finally(() => {
        uploadActive--;
        const next = uploadQueue.shift();
        if (next) {
          uploadActive++;
          next();
        }
      });
    });
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function sseStream(lines: string[]): Response {
  const enc = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i >= lines.length) {
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(`data: ${lines[i++]}\n\n`));
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

async function llmComplete(prompt: string): Promise<string> {
  // omp-configured default: local proxy + deepseek v4.1 flash (no key needed on loopback).
  // Override with LLM_BASE_URL / LLM_API_KEY / LLM_MODEL env (see .env.example).
  const base = process.env.LLM_BASE_URL ?? "http://127.0.0.1:8787/v1";
  const key = process.env.LLM_API_KEY ?? "proxy-managed";
  const model = process.env.LLM_MODEL ?? "deepseek/deepseek-v4.1-flash";
  if (!base) return "";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data = (await res.json()) as unknown as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

type UploadDraft = Parameters<typeof savePaper>[0];

async function extractUpload(id: string, fileName: string, buf: Uint8Array, pdfPath: string): Promise<UploadDraft> {
  const base = {
    id,
    authors: [],
    year: null,
    link: "",
    source: "upload",
    pdfPath,
  };
  // sha256 for dedupe (PLAN §4 promised, now wired)
  const hash = new Bun.CryptoHasher("sha256").update(buf).digest("hex");
  try {
    const native = (await pdfToMarkdown(buf)) as unknown as {
      title?: string;
      markdown?: string;
      pageCount?: number;
      pagesNeedingOcr?: number[];
    };
    const abstract = native.markdown ?? "";
    const gaps = native.pagesNeedingOcr ?? [];
    // title fallback chain: native meta → first non-watermark heading in HEAD → filename → hash short.
    // arXiv cover watermark ("arXiv:1706.03762v7 [cs.CL] ...") must not become the title.
    // Only the first 5 headings count: deep body heads must never win.
    const h1s = [...abstract.matchAll(/^#{1,3}\s+(.+)$/gm)].slice(0, 5).map((m) => (m[1] ?? "").trim().replace(/\*\*/g, ""));
    const h1 = h1s.find((t) => t && !/^arXiv:\d/i.test(t) && t.length > 12);
    const title = native.title?.trim() || h1 || fileName.replace(/\.pdf$/i, "") || `PDF ${hash.slice(0, 8)}`;
    // Drop cover boilerplate (arXiv watermark line, permission grants) so cards/LLM start at content.
    // Then skip the title+author block (first H1 and following **author** lines repeat card meta).
    const cleaned = abstract
      .replace(/^\s*#\s+arXiv:\S+.*$/gim, "")
      .replace(/^\s*#{1,4}\s*Provided proper attribution is provided,.*$/gim, "")
      .replace(/^\s*Google hereby grants permission.*$/gim, "")
      .replace(/^\s*(?:#{1,4}\s*)?reproduce the tables and figures.*$/gim, "")
      .replace(/^\s*solely for use in journalistic or scholarly works\..*$/gim, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const lines = cleaned.split("\n");
    let cut = 0;
    for (let i = 0; i < Math.min(lines.length, 16); i++) {
      const line = (lines[i] ?? "").trim();
      if (!line || /^<!--/.test(line)) continue;
      if (/^#{1,6}\s+/.test(line) && !/^#{1,6}\s+(abstract|introduction)/i.test(line)) continue;
      if (/^\*\*/.test(line)) continue;
      if (line.includes("@") && line.length < 80) continue;
      if (/^(google brain|google research|deepmind|openai|meta ai)/i.test(line)) continue;
      cut = i;
      break;
    }
    const body = lines.slice(cut).join("\n").trim() || cleaned;
    return {
      ...base,
      id: `pdf:${hash.slice(0, 16)}`,
      title,
      abstract: body.slice(0, 6000),
      extractionStatus: abstract ? (gaps.length ? "partial_text" : "text_extracted") : "no_text",
      pagesWithoutText: gaps,
      pageCount: native.pageCount ?? null,
    };
  } catch {
    const probe = await probePdf(buf);
    return {
      ...base,
      id: `pdf:${hash.slice(0, 16)}`,
      title: probe.title ?? fileName.replace(/\.pdf$/i, "") ?? `PDF ${hash.slice(0, 8)}`,
      abstract: probe.text.slice(0, 2000),
      extractionStatus: probe.extractionStatus,
      pagesWithoutText: probe.pagesWithoutText,
      pageCount: probe.pageCount,
    };
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname, searchParams } = url;

    if (pathname === "/" || pathname === "/index.html") return new Response(Bun.file(`${import.meta.dir}/index.html`));

    // pdfrx WASM engine assets (self-hosted, offline-capable)
    if (pathname === "/pdfium/pdfium.wasm") {
      return new Response(Bun.file(`${import.meta.dir}/public/pdfium/pdfium.wasm`), {
        headers: { "Content-Type": "application/wasm", "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }
    if (pathname === "/pdfium/pdfium_worker.js") {
      return new Response(Bun.file(`${import.meta.dir}/public/pdfium/pdfium_worker.js`), {
        headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }
    // pdfrx ESM packages (self-hosted, no npm CDN): /pdfrx/viewer/dist/index.js etc.
    if (pathname.startsWith("/pdfrx/")) {
      const rel = pathname.slice("/pdfrx/".length);
      if (rel.includes("..") || rel.includes("//")) return json({ error: "bad path" }, 400);
      const file = Bun.file(`${import.meta.dir}/node_modules/@pdfrx/${rel}`);
      if (!(await file.exists())) return json({ error: "not found" }, 404);
      const ct = rel.endsWith(".wasm") ? "application/wasm" : "text/javascript";
      return new Response(file, { headers: { "Content-Type": ct, "Cache-Control": "public, max-age=3600" } });
    }
    if (pathname === "/api/search" && req.method === "GET") {
      const q = searchParams.get("q") ?? "";
      if (!q) return json({ papers: [], warnings: [], sourceStatus: [] });
      return json(await searchPapers(q));
    }

    // Library CRUD (SQLite local, persists across restarts)
    if (pathname === "/api/library" && req.method === "GET") return json({ papers: listPapers() });
    if (pathname === "/api/library" && req.method === "POST") {
      const body = (await req.json()) as unknown as Parameters<typeof savePaper>[0];
      return json({ paper: savePaper(body) }, 201);
    }
    const libDel = pathname.match(/^\/api\/library\/(.+)$/);
    if (libDel && req.method === "DELETE") {
      deletePaper(decodeURIComponent(libDel[1] ?? ""));
      return json({ ok: true });
    }

    // Upload PDF: native C engine first (CMap/markdown), TS probe fallback.
    // id is content-hash (extractUpload), same file twice = same row (dedupe).
    if (pathname === "/api/upload" && req.method === "POST") {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return json({ error: "file required" }, 400);
      const buf = new Uint8Array(await file.arrayBuffer());
      const paper = savePaper(await runUpload(async () => {
        const draft = await extractUpload("tmp", file.name, buf, "tmp");
        const pdfPath = `${PAPERS_DIR}/${draft.id}.pdf`;
        await Bun.write(pdfPath, buf);
        return { ...draft, pdfPath };
      }));
      return json({ paper, queue: uploadStatus() }, 201);
    }

    if (pathname === "/api/queue" && req.method === "GET") return json(uploadStatus());

    // Fetch online PDF by URL into local library (seamless online->local).
    // SSRF-guarded + size-capped; same native extract path as upload.
    // arXiv URLs get metadata backfill (true title/authors/year from API).
    if (pathname === "/api/fetch" && req.method === "POST") {
      const body = (await req.json()) as unknown as { url?: string; title?: string };
      const target = body.url ?? "";
      if (!isPublicHttpUrl(target)) return json({ error: "blocked: non-public URL" }, 400);
      try {
        const head = await fetch(target, { method: "HEAD", redirect: "follow" });
        const len = Number(head.headers.get("content-length") ?? 0);
        if (len > MAX_DOWNLOAD_MB * 1024 * 1024) return json({ error: "blocked: too large" }, 413);
      } catch {
        // HEAD blocked by host (arXiv etc.) — fall through to GET with byte cap
      }
      const res = await fetch(target, { redirect: "follow", headers: { "User-Agent": "HW1-Research-Assistant/0.1" } });
      if (!res.ok) return json({ error: `fetch ${res.status}` }, 502);
      const ctype = res.headers.get("content-type") ?? "";
      if (!ctype.includes("pdf") && !target.toLowerCase().endsWith(".pdf")) {
        return json({ error: `not a PDF (${ctype || "unknown type"})` }, 415);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > MAX_DOWNLOAD_MB * 1024 * 1024) return json({ error: "blocked: too large" }, 413);
      const arxivId = target.match(/arxiv\.org\/(?:pdf|abs)\/(\d{4}\.\d{4,5})/)?.[1];
      const meta = arxivId ? await lookupArxiv(arxivId).catch(() => null) : null;
      const metaMiss = Boolean(arxivId) && !meta;
      const paper = savePaper(await runUpload(async () => {
        const draft = await extractUpload("tmp", body.title ?? meta?.title ?? target.split("/").pop() ?? "fetched", buf, "tmp");
        const pdfPath = `${PAPERS_DIR}/${draft.id}.pdf`;
        await Bun.write(pdfPath, buf);
        return {
          ...draft,
          title: meta?.title ?? draft.title,
          authors: meta?.authors?.length ? meta.authors : draft.authors,
          year: meta?.year ?? draft.year,
          pdfPath, link: target, source: "fetch",
        };
      }));
      return json({ paper, queue: uploadStatus(), metaMiss }, 201);
    }

    // Serve uploaded PDF bytes for right-pane preview
    const pdfMatch = pathname.match(/^\/api\/pdf\/(.+)$/);
    if (pdfMatch && req.method === "GET") {
      const paper = getPaper(decodeURIComponent(pdfMatch[1] ?? ""));
      if (!paper?.pdfPath) return json({ error: "not found" }, 404);
      return new Response(Bun.file(paper.pdfPath), { headers: { "Content-Type": "application/pdf" } });
    }

    // Summarize (SSE): library first, then search-seen snapshot (search-to-ask without save).
    // Excerpt keeps <!-- Page N --> boundaries so cites diversify beyond [p.1].
    if (pathname === "/api/summarize" && req.method === "GET") {
      const paper = getPaper(searchParams.get("id") ?? "") ?? getSeenPaper(searchParams.get("id") ?? "");
      if (!paper) return json({ error: "not found" }, 404);
      const prompt = `Summarize ONLY the excerpt below in 3 numbered points. The excerpt has <!-- Page N --> markers: cite the page each fact came from like [p.1] or [p.2]. Use at least 2 different pages when the excerpt spans them. Never invent cites.\nTitle: ${paper.title}\nExcerpt: ${paper.abstract.slice(0, 6000)}`;
      try {
        const real = await llmComplete(prompt);
        if (real) return sseStream(real.match(/.{1,200}/g) ?? [real]);
      } catch {
        // fall through to mock
      }
      return sseStream(
        [`Summary of "${paper.title.slice(0, 60)}" (mock — set LLM_BASE_URL + LLM_API_KEY for real).`, `Abstract head: ${paper.abstract.slice(0, 200)}...`].map((s) => JSON.stringify({ text: s })),
      );
    }

    // Ask (SSE): same resolution
    if (pathname === "/api/ask" && req.method === "GET") {
      const paper = getPaper(searchParams.get("id") ?? "") ?? getSeenPaper(searchParams.get("id") ?? "");
      const q = searchParams.get("q") ?? "";
      if (!paper) return json({ error: "not found" }, 404);
      const prompt = `Answer ONLY from the excerpt below (<!-- Page N --> markers). At most 5 sentences, each under 40 words. End each factual sentence with its page like [p.1] or [p.2-3]; one cite per sentence max. If the excerpt lacks the answer, say so in one sentence and do not invent.\nTitle: ${paper.title}\nExcerpt: ${paper.abstract.slice(0, 6000)}\nQuestion: ${q}`;
      try {
        const real = await llmComplete(prompt);
        if (real) return sseStream(real.match(/.{1,200}/g) ?? [real]);
      } catch {
        // fall through
      }
      return sseStream([JSON.stringify({ text: `(mock — set LLM keys for real) Q: ${q} A: based on abstract head: ${paper.abstract.slice(0, 200)}...` })]);
    }

    // Read cursor: paged text window over stored abstract (uploaded PDFs: probed text).
    // Mirrors the continuation idea: client walks offset->null instead of assuming full read.
    if (pathname === "/api/read" && req.method === "GET") {
      const paper = getPaper(searchParams.get("id") ?? "");
      if (!paper) return json({ error: "not found" }, 404);
      const offset = Math.max(0, Number(searchParams.get("offset") ?? 0));
      const limit = Math.min(20000, Math.max(1, Number(searchParams.get("limit") ?? 12000)));
      const full = paper.abstract;
      const end = Math.min(full.length, offset + limit);
      const nextOffset = end < full.length ? end : null;
      return json({
        id: paper.id,
        offset,
        end,
        totalChars: full.length,
        text: full.slice(offset, end),
        nextOffset,
        endOfDocument: nextOffset === null,
        extractionStatus: paper.extractionStatus ?? "not_applicable",
        pagesWithoutText: paper.pagesWithoutText ?? [],
      });
    }

    // Settings status (omp-configure mirror): which keys are active, never the values.
    // Key source of truth is process env (.env project file, never committed).
    if (pathname === "/api/settings" && req.method === "GET") {
      return json({
        llm: {
          baseUrl: process.env.LLM_BASE_URL ?? "http://127.0.0.1:8787/v1",
          model: process.env.LLM_MODEL ?? "deepseek/deepseek-v4.1-flash",
          keySet: Boolean(process.env.LLM_API_KEY),
          mode: process.env.LLM_API_KEY ? "custom-key" : "proxy-managed",
        },
        exa: { keySet: Boolean(process.env.EXA_API_KEY), mode: process.env.EXA_API_KEY ? "full-api" : "keyless-mcp" },
      });
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`MVP on http://localhost:${server.port}`);
console.log(`exa: ${process.env.EXA_API_KEY ? "key set (full API)" : "keyless MCP"} | llm: ${process.env.LLM_MODEL ?? "deepseek/deepseek-v4.1-flash"} via ${process.env.LLM_BASE_URL ?? "http://127.0.0.1:8787/v1"} (${process.env.LLM_API_KEY ? "custom-key" : "proxy-managed"})`);
