import type { Paper } from "./db.ts";

export type SourceStatus = {
  source: string;
  status: "ok" | "limited" | "error" | "skipped";
  returnedCount: number;
  sortApplied: string;
  notes: string[];
  error?: string;
  retryable: boolean;
};

export type SearchBundle = {
  papers: Paper[];
  warnings: string[];
  sourceStatus: SourceStatus[];
};

const ARXIV = "https://export.arxiv.org/api/query";

type ExaResultItem = {
  id?: string;
  title?: string;
  author?: string;
  authors?: string[];
  publishedDate?: string;
  text?: string;
  snippet?: string;
  url?: string;
};

type ExaResponse = { results?: ExaResultItem[] };

type SsAuthor = { name?: string };
type SsItem = {
  paperId?: string;
  title?: string;
  abstract?: string;
  authors?: SsAuthor[];
  year?: number;
  publicationDate?: string;
  url?: string;
  openAccessPdf?: { url?: string };
  citationCount?: number;
};
type SsResponse = { data?: SsItem[]; total?: number };

type OaAuthor = { name?: string };
type OaItem = {
  id?: string;
  title?: string;
  abstract_inverted_index?: Record<string, number[]>;
  authorships?: { author?: OaAuthor }[];
  publication_year?: number;
  doi?: string;
  primary_location?: { pdf_url?: string; landing_page_url?: string };
};
type OaResponse = { results?: OaItem[]; meta?: { count?: number } };

function decodeInvertedIndex(index: Record<string, number[]> | undefined): string {
  if (!index) return "";
  const slots: string[] = [];
  for (const word of Object.keys(index)) {
    for (const pos of index[word] ?? []) slots[pos] = word;
  }
  return slots.filter(Boolean).join(" ");
}

function dedupeKey(title: string): string {
  const norm = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // Truncation-proof: sources cut titles at different lengths ("...AI ..." vs "...AI ...").
  // Collapse interior whitespace runs, cut trailing partial token, cap at 12 tokens.
  const toks = norm.split(/\s+/).filter(Boolean).slice(0, 12);
  return toks.join(" ");
}

function mergePapers(lists: Paper[][]): Paper[] {
  const seen = new Map<string, Paper>();
  for (const list of lists) {
    for (const p of list) {
      const key = dedupeKey(p.title);
      if (!key || seen.has(key)) continue;
      // Near-dup: same first 8 tokens as an existing key (one source truncated later)
      const head = key.split(" ").slice(0, 8).join(" ");
      let dup = false;
      for (const k of seen.keys()) {
        if (k === key || k.startsWith(head) || head.startsWith(k.split(" ").slice(0, 8).join(" "))) { dup = true; break; }
      }
      if (dup) continue;
      seen.set(key, p);
    }
  }
  return [...seen.values()];
}

function extractEntryField(entry: string, re: RegExp): string {
  const m = entry.match(re);
  return m?.[1]?.trim().replace(/\s+/g, " ") ?? "";
}

// Metadata backfill: arXiv id → true title/authors/year (arXiv API only).
// No fuzzy fallback: a wrong-paper backfill is worse than a filename placeholder + metaMiss flag.
export async function lookupArxiv(id: string): Promise<Pick<Paper, "title" | "authors" | "year"> | null> {
  const clean = id.replace(/v\d+$/, "");
  try {
    const res = await fetch(`${ARXIV}?search_query=id:${encodeURIComponent(clean)}&max_results=1`, {
      headers: { "User-Agent": "HW1-Research-Assistant/0.1" },
    });
    if (!res.ok) return null;
    const xml = await res.text();
    if (/rate exceeded/i.test(xml)) return null;
    const entry = xml.split(/<entry>/)[1];
    if (!entry) return null;
    const title = extractEntryField(entry, /<title>([\s\S]*?)<\/title>/);
    const published = extractEntryField(entry, /<published>([\s\S]*?)<\/published>/);
    const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => (m[1] ?? "").trim());
    if (!title) return null;
    return { title, authors, year: published ? Number(published.slice(0, 4)) : null };
  } catch {
    return null;
  }
}

async function searchArxiv(query: string, limit: number): Promise<{ papers: Paper[]; status: SourceStatus }> {
  const url = `${ARXIV}?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}&sortBy=relevance&sortOrder=descending`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "HW1-Research-Assistant/0.1" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const papers = xml
      .split(/<entry>/)
      .slice(1)
      .map((entry) => {
        const idUrl = extractEntryField(entry, /<id>([\s\S]*?)<\/id>/);
        const arxivId = idUrl.split("/abs/")[1]?.split("v")[0] ?? `unknown-${Math.random().toString(36).slice(2)}`;
        const title = extractEntryField(entry, /<title>([\s\S]*?)<\/title>/);
        const abstract = extractEntryField(entry, /<summary>([\s\S]*?)<\/summary>/);
        const published = extractEntryField(entry, /<published>([\s\S]*?)<\/published>/);
        const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => (m[1] ?? "").trim());
        const paper: Paper = {
          id: `arxiv:${arxivId}`,
          title,
          authors,
          year: published ? Number(published.slice(0, 4)) : null,
          abstract,
          link: idUrl,
          source: "arXiv",
          pdfPath: null,
          createdAt: Date.now(),
        };
        return paper;
      });
    return { papers, status: { source: "arXiv", status: "ok", returnedCount: papers.length, sortApplied: "relevance", notes: [], retryable: false } };
  } catch (e) {
    return {
      papers: [],
      status: { source: "arXiv", status: "error", returnedCount: 0, sortApplied: "relevance", notes: [], error: String(e), retryable: true },
    };
  }
}

async function searchSemanticScholar(query: string, limit: number): Promise<{ papers: Paper[]; status: SourceStatus }> {
  try {
    const params = new URLSearchParams({
      query,
      limit: String(Math.min(limit, 100)),
      fields: "title,abstract,authors,year,publicationDate,url,externalIds,citationCount,openAccessPdf",
    });
    const res = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, {
      headers: { "User-Agent": "HW1-Research-Assistant/0.1" },
    });
    if (res.status === 429) {
      return { papers: [], status: { source: "SemanticScholar", status: "limited", returnedCount: 0, sortApplied: "relevance", notes: ["rate-limited"], retryable: true } };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as unknown as SsResponse;
    const papers = (data.data ?? []).map((item, i): Paper => {
      const pdfUrl = item.openAccessPdf?.url ?? "";
      return {
        id: `ss:${item.paperId ?? `${Date.now()}-${i}`}`,
        title: item.title ?? "",
        authors: (item.authors ?? []).map((a) => a.name ?? "").filter(Boolean),
        year: item.year ?? (item.publicationDate ? Number(item.publicationDate.slice(0, 4)) : null),
        abstract: item.abstract ?? "",
        link: pdfUrl || item.url || "",
        source: "SemanticScholar",
        pdfPath: null,
        createdAt: Date.now(),
      };
    });
    return { papers, status: { source: "SemanticScholar", status: "ok", returnedCount: papers.length, sortApplied: "relevance", notes: [], retryable: false } };
  } catch (e) {
    return {
      papers: [],
      status: { source: "SemanticScholar", status: "error", returnedCount: 0, sortApplied: "relevance", notes: [], error: String(e), retryable: true },
    };
  }
}

async function searchOpenAlex(query: string, limit: number): Promise<{ papers: Paper[]; status: SourceStatus }> {
  try {
    const params = new URLSearchParams({ search: query, per_page: String(Math.min(limit, 50)) });
    const res = await fetch(`https://api.openalex.org/works?${params}`, {
      headers: { "User-Agent": "HW1-Research-Assistant/0.1 (mailto:hw1@example.edu)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as unknown as OaResponse;
    const papers = (data.results ?? []).map((item, i): Paper => {
      const oaId = item.id?.split("/").pop() ?? `${Date.now()}-${i}`;
      const pdfUrl = item.primary_location?.pdf_url ?? "";
      return {
        id: `openalex:${oaId}`,
        title: item.title ?? "",
        authors: (item.authorships ?? []).map((a) => a.author?.name ?? "").filter(Boolean),
        year: item.publication_year ?? null,
        abstract: decodeInvertedIndex(item.abstract_inverted_index).slice(0, 2000),
        link: pdfUrl || item.primary_location?.landing_page_url || item.doi || "",
        source: "OpenAlex",
        pdfPath: null,
        createdAt: Date.now(),
      };
    });
    return { papers, status: { source: "OpenAlex", status: "ok", returnedCount: papers.length, sortApplied: "relevance", notes: [], retryable: false } };
  } catch (e) {
    return {
      papers: [],
      status: { source: "OpenAlex", status: "error", returnedCount: 0, sortApplied: "relevance", notes: [], error: String(e), retryable: true },
    };
  }
}

async function searchExa(query: string, limit: number): Promise<{ papers: Paper[]; status: SourceStatus }> {
  const key = process.env.EXA_API_KEY;
  // Key path: full /search API
  if (key) {
    try {
      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, type: "auto", category: "publication", numResults: limit }),
      });
      if (res.status === 429) {
        return { papers: [], status: { source: "Exa", status: "limited", returnedCount: 0, sortApplied: "auto", notes: ["rate-limited"], retryable: true } };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as unknown as ExaResponse;
      const papers = (data.results ?? []).map((r, i): Paper => ({
        id: `exa:${r.id ?? i}`,
        title: r.title ?? "",
        authors: r.author ? [r.author] : (r.authors ?? []),
        year: r.publishedDate ? Number(r.publishedDate.slice(0, 4)) : null,
        abstract: r.text?.slice(0, 1000) ?? r.snippet ?? "",
        link: r.url ?? "",
        source: "Exa",
        pdfPath: null,
        createdAt: Date.now(),
      }));
      return { papers, status: { source: "Exa", status: "ok", returnedCount: papers.length, sortApplied: "auto", notes: [], retryable: false } };
    } catch (e) {
      return {
        papers: [],
        status: { source: "Exa", status: "error", returnedCount: 0, sortApplied: "auto", notes: [], error: String(e), retryable: true },
      };
    }
  }
  // Keyless path (omp fallback): public MCP web_search_exa, no auth
  try {
    const res = await fetch("https://mcp.exa.ai/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "web_search_exa", arguments: { query, count: limit } },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const data = JSON.parse(body.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? body) as unknown as {
      result?: { content?: { type?: string; text?: string }[] };
    };
    const text = data.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
    const blocks = text.split(/Title:\s*/).slice(1);
    const papers = blocks.map((b, i): Paper => {
      const title = (b.split("\n")[0] ?? "").trim();
      const url = (b.match(/URL:\s*(https?:\/\/\S+)/)?.[1] ?? "").trim();
      const published = b.match(/Published:\s*(\d{4})/)?.[1];
      const authorLine = b.match(/Author:\s*([^\n]+)/)?.[1]?.trim() ?? "";
      const highlights = b.match(/Highlights:\s*([\s\S]*?)(?=\nTitle:|$)/)?.[1]?.trim() ?? "";
      return {
        id: `exa-mcp:${Date.now()}-${i}`,
        title,
        authors: authorLine ? authorLine.split(/[,;]/).map((a) => a.trim()).filter(Boolean) : [],
        year: published ? Number(published) : null,
        abstract: highlights.slice(0, 1000),
        link: url,
        source: "Exa",
        pdfPath: null,
        createdAt: Date.now(),
      };
    }).filter((p) => p.title || p.link);
    return { papers, status: { source: "Exa", status: "ok", returnedCount: papers.length, sortApplied: "auto", notes: ["keyless-mcp"], retryable: false } };
  } catch (e) {
    return {
      papers: [],
      status: { source: "Exa", status: "error", returnedCount: 0, sortApplied: "auto", notes: ["keyless-mcp"], error: String(e), retryable: true },
    };
  }
}

const searchCache = new Map<string, { at: number; bundle: SearchBundle }>();
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const SOURCE_TIMEOUT_MS = 8000;

const seenPapers = new Map<string, Paper>();

export function getSeenPaper(id: string): Paper | undefined {
  return seenPapers.get(id);
}

export async function searchPapers(query: string, limitPerSource = 8): Promise<SearchBundle> {
  const key = `${query}::${limitPerSource}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.bundle, sourceStatus: hit.bundle.sourceStatus.map((s) => ({ ...s, notes: [...s.notes, "cached"] })) };
  }
  // Timeout-bounded parallel: slow sources degrade to error status instead of hanging the bundle
  const names = ["Exa", "SemanticScholar", "OpenAlex", "arXiv"];
  const sources = [searchExa(query, limitPerSource), searchSemanticScholar(query, limitPerSource), searchOpenAlex(query, limitPerSource), searchArxiv(query, limitPerSource)];
  const bounded = sources.map((p, i) =>
    Promise.race([
      p,
      new Promise<{ papers: Paper[]; status: SourceStatus }>((resolve) =>
        setTimeout(() => resolve({ papers: [], status: { source: names[i] ?? `source-${i}`, status: "limited", returnedCount: 0, sortApplied: "relevance", notes: ["timeout"], retryable: true } }), SOURCE_TIMEOUT_MS),
      ),
    ]),
  );
  const settled = await Promise.all(bounded);
  const warnings = settled
    .filter((s) => s.status.status === "error" || s.status.status === "limited")
    .map((s) => `${s.status.source}: ${s.status.error ?? s.status.notes.join(",") ?? s.status.status}`);
  const papers = mergePapers(settled.map((s) => s.papers));
  for (const p of papers) seenPapers.set(p.id, p);
  if (seenPapers.size > 2000) {
    const drop = seenPapers.size - 2000;
    const keys = seenPapers.keys();
    for (let i = 0; i < drop; i++) seenPapers.delete(keys.next().value ?? "");
  }
  const bundle = { papers, warnings, sourceStatus: settled.map((s) => s.status) };
  if (searchCache.size >= 100) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { at: Date.now(), bundle });
  return bundle;
}
