import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Paper } from "../../lib/db.ts";
import { decodeInvertedIndex, dedupeKey, getSeenPaper, lookupArxiv, mergePapers, searchPapers } from "../../lib/search.ts";

const realFetch = globalThis.fetch;
let calls = 0;

const basePaper: Paper = {
  id: "helper",
  title: "",
  authors: [],
  year: null,
  abstract: "",
  link: "",
  source: "test",
  pdfPath: null,
  createdAt: 0,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (body: string, status = 200) => new Response(body, { status });

const exaKeyless = () =>
  text(
    "data: " +
      JSON.stringify({
        result: {
          content: [
            {
              type: "text",
              text: [
                "Title: Paper One",
                "URL: https://example.com/one",
                "Published: 2024",
                "Author: Alice, Bob",
                "Highlights: first abstract",
                "Title: Paper Two",
                "URL: https://example.com/two",
                "Published: 2023",
                "Author: Carol",
                "Highlights: second abstract",
              ].join("\n"),
            },
          ],
        },
      }),
  );

const semanticScholar = () =>
  json({
    data: [
      {
        paperId: "s1",
        title: "Semantic Paper",
        abstract: "semantic abstract",
        authors: [{ name: "Dana" }],
        year: 2022,
        url: "https://semantic.example",
      },
    ],
  });

const openAlex = () =>
  json({
    results: [
      {
        id: "https://openalex.org/W9",
        title: "Open Alex Paper",
        abstract_inverted_index: { Hello: [0], world: [1] },
        authorships: [{ author: { name: "Eve" } }],
        publication_year: 2021,
        doi: "https://doi.org/x",
      },
    ],
  });

const arxivFeed = () =>
  text(
    "<feed><entry><id>http://arxiv.org/abs/2401.00001v1</id><title>Arxiv Paper</title>" +
      "<summary>arxiv abstract</summary><published>2020-01-01T00:00:00Z</published>" +
      "<author><name>Frank</name></author></entry></feed>",
  );

function stub(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const defaults: Record<string, () => Response | Promise<Response>> = {
    "mcp.exa.ai": exaKeyless,
    "api.exa.ai": () => json({ results: [] }),
    "api.semanticscholar.org": semanticScholar,
    "api.openalex.org": openAlex,
    "export.arxiv.org": arxivFeed,
  };
  const routes = { ...defaults, ...overrides };
  globalThis.fetch = (async (input: unknown) => {
    calls++;
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const hit = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    return hit[1]();
  }) as typeof fetch;
}

beforeEach(() => {
  calls = 0;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.EXA_API_KEY;
});

describe("searchPapers", () => {
  test("merges four sources and reports ok statuses", async () => {
    stub();
    const bundle = await searchPapers("merge-basic");

    expect(bundle.papers.map((p) => p.title).sort()).toEqual([
      "Arxiv Paper",
      "Open Alex Paper",
      "Paper One",
      "Paper Two",
      "Semantic Paper",
    ]);
    expect(bundle.sourceStatus.map((s) => [s.source, s.status])).toEqual([
      ["Exa", "ok"],
      ["SemanticScholar", "ok"],
      ["OpenAlex", "ok"],
      ["arXiv", "ok"],
    ]);
    expect(bundle.warnings).toEqual([]);
  });

  test("collapses duplicate titles across sources", async () => {
    stub({
      "mcp.exa.ai": () =>
        text("data: " + JSON.stringify({ result: { content: [{ type: "text", text: "Title: Same Paper\nURL: https://a\nHighlights: h" }] } })),
      "api.semanticscholar.org": () =>
        json({ data: [{ paperId: "s2", title: "Same Paper", abstract: "", authors: [], year: null, url: "https://b" }] }),
    });

    const bundle = await searchPapers("dedupe-q");
    expect(bundle.papers).toHaveLength(3);
    expect(bundle.papers.filter((p) => p.title === "Same Paper")).toHaveLength(1);
  });

  test("degrades a 429 source to limited and warns", async () => {
    stub({ "api.semanticscholar.org": () => json({}, 429) });
    const bundle = await searchPapers("ss-429-q");

    expect(bundle.sourceStatus[1]).toMatchObject({ source: "SemanticScholar", status: "limited", returnedCount: 0 });
    expect(bundle.warnings.join(" ")).toContain("rate-limited");
    expect(bundle.papers.length).toBeGreaterThan(0);
  });

  test("degrades a 500 source to error and warns", async () => {
    stub({ "api.semanticscholar.org": () => json({}, 500) });
    const bundle = await searchPapers("ss-500-q");

    expect(bundle.sourceStatus[1]).toMatchObject({ source: "SemanticScholar", status: "error" });
    expect(bundle.warnings.join(" ")).toContain("HTTP 500");
  });

  test("parses keyless Exa blocks into structured papers", async () => {
    stub();
    const bundle = await searchPapers("exa-parse-q");
    const one = bundle.papers.find((p) => p.title === "Paper One");

    expect(one).toBeDefined();
    expect(one?.authors).toEqual(["Alice", "Bob"]);
    expect(one?.year).toBe(2024);
    expect(one?.link).toBe("https://example.com/one");
    expect(one?.abstract).toBe("first abstract");
  });

  test("uses the Exa API path when a key is present", async () => {
    process.env.EXA_API_KEY = "test-key";
    try {
      stub({
        "api.exa.ai": () =>
          json({
            results: [
              { id: "e1", title: "Exa API Paper", author: "Zoe", publishedDate: "2024-05-01", text: "api abstract", url: "https://exa.ai/x" },
            ],
          }),
      });

      const bundle = await searchPapers("exa-key-q");
      const paper = bundle.papers.find((p) => p.title === "Exa API Paper");

      expect(bundle.sourceStatus[0]).toMatchObject({ source: "Exa", status: "ok" });
      expect(paper?.authors).toEqual(["Zoe"]);
    } finally {
      delete process.env.EXA_API_KEY;
    }
  });

  test("degrades an Exa API 429 to limited", async () => {
    process.env.EXA_API_KEY = "test-key";
    try {
      stub({ "api.exa.ai": () => json({}, 429) });
      const bundle = await searchPapers("exa-429-q");
      expect(bundle.sourceStatus[0]).toMatchObject({ source: "Exa", status: "limited" });
    } finally {
      delete process.env.EXA_API_KEY;
    }
  });

  test("degrades an Exa API 500 to error", async () => {
    process.env.EXA_API_KEY = "test-key";
    try {
      stub({ "api.exa.ai": () => json({}, 500) });
      const bundle = await searchPapers("exa-500-q");
      expect(bundle.sourceStatus[0]).toMatchObject({ source: "Exa", status: "error" });
    } finally {
      delete process.env.EXA_API_KEY;
    }
  });

  test("degrades a keyless Exa transport failure to error", async () => {
    stub({
      "mcp.exa.ai": () => {
        throw new Error("network down");
      },
    });
    const bundle = await searchPapers("exa-net-q");
    expect(bundle.sourceStatus[0]).toMatchObject({ source: "Exa", status: "error" });
  });

  test("degrades an arXiv transport failure to error", async () => {
    stub({
      "export.arxiv.org": () => {
        throw new Error("tls failure");
      },
    });
    const bundle = await searchPapers("arxiv-net-q");
    const status = bundle.sourceStatus.find((s) => s.source === "arXiv");
    expect(status?.status).toBe("error");
  });

  test("degrades an OpenAlex 500 to error", async () => {
    stub({ "api.openalex.org": () => json({}, 500) });
    const bundle = await searchPapers("oa-500-q");
    const status = bundle.sourceStatus.find((s) => s.source === "OpenAlex");
    expect(status?.status).toBe("error");
  });

  test("serves repeated queries from cache without refetching", async () => {
    stub();
    await searchPapers("cache-q");
    const afterFirst = calls;
    const second = await searchPapers("cache-q");

    expect(calls).toBe(afterFirst);
    expect(second.sourceStatus.every((s) => s.notes.includes("cached"))).toBe(true);
  });

  test("evicts the oldest cache entry after 100 queries", async () => {
    stub();
    for (let i = 0; i < 101; i++) await searchPapers(`evict-${i}`);
    const before = calls;

    await searchPapers("evict-0");
    expect(calls).toBeGreaterThan(before);
  });

  test("turns a source that exceeds the 8s budget into limited/timeout", async () => {
    stub({ "api.semanticscholar.org": () => new Promise<Response>(() => {}) });
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === 8000) return realSetTimeout(fn, 0, ...args);
      return realSetTimeout(fn, ms, ...args);
    }) as unknown as typeof setTimeout;

    try {
      const bundle = await searchPapers("timeout-q");
      const statuses = Object.fromEntries(bundle.sourceStatus.map((s) => [s.source, s.status]));
      expect(statuses.SemanticScholar).toBe("limited");
      expect(statuses.Exa).toBe("ok");
      expect(statuses.OpenAlex).toBe("ok");
      expect(statuses.arXiv).toBe("ok");
      expect(bundle.papers.length).toBeGreaterThan(0);
      const notes = bundle.sourceStatus.find((s) => s.source === "SemanticScholar")?.notes ?? [];
      expect(notes).toContain("timeout");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("evicts the oldest seen papers beyond the 2000-entry cap", async () => {
    process.env.EXA_API_KEY = "test-key";
    let n = 0;
    stub({
      "api.exa.ai": () => {
        const results = [
          { id: `cap-${n}-a`, title: `Cap Paper ${n}-A`, author: "A", publishedDate: "2024-01-01", text: "x", url: `https://a/${n}` },
          { id: `cap-${n}-b`, title: `Cap Paper ${n}-B`, author: "B", publishedDate: "2024-01-01", text: "y", url: `https://b/${n}` },
        ];
        n++;
        return json({ results });
      },
      "api.semanticscholar.org": () => json({ data: [] }),
      "api.openalex.org": () => json({ results: [] }),
      "export.arxiv.org": () => text("<feed></feed>"),
    });

    try {
      const ids: string[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < 1100; i++) {
        const bundle = await searchPapers(`seen-cap-${i}`);
        for (const p of bundle.papers) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          ids.push(p.id);
        }
      }

      expect(ids.length).toBeGreaterThan(2000);
      const present = ids.filter((id) => getSeenPaper(id) !== undefined);
      expect(present).toHaveLength(2000);
      expect(present[0]).toBe(ids[ids.length - 2000]);
    } finally {
      delete process.env.EXA_API_KEY;
    }
  });

  test("registers merged papers for later summarize/ask lookup", async () => {
    stub();
    const bundle = await searchPapers("seen-q");
    const first = bundle.papers[0];

    expect(first).toBeDefined();
    expect(getSeenPaper(first!.id)?.title).toBe(first!.title);
  });
});

describe("pure helpers", () => {
  test("decodes an inverted index in position order", () => {
    expect(decodeInvertedIndex({ world: [1], Hello: [0], again: [2] })).toBe("Hello world again");
    expect(decodeInvertedIndex(undefined)).toBe("");
  });

  test("normalizes titles for dedupe", () => {
    expect(dedupeKey("Attention: Is All You Need!")).toBe("attention is all you need");
    expect(dedupeKey("A  B\tC")).toBe("a b c");
    expect(dedupeKey("!!!")).toBe("");
  });

  test("merges lists and drops exact and near duplicates", () => {
    const p = (title: string): Paper => ({ ...basePaper, title });
    const merged = mergePapers([
      [p("Attention Is All You Need")],
      [p("Attention Is All You Need"), p("Attention Is All You Need For Long Contexts")],
    ]);
    expect(merged).toHaveLength(1);
  });

  test("keeps titles whose first tokens differ", () => {
    const p = (title: string): Paper => ({ ...basePaper, title });
    expect(mergePapers([[p("Alpha Study")], [p("Beta Study")]])).toHaveLength(2);
  });
});

describe("lookupArxiv", () => {
  test("returns null when the transport throws", async () => {
    stub({
      "export.arxiv.org": () => {
        throw new Error("dns failure");
      },
    });
    expect(await lookupArxiv("2401.00004")).toBeNull();
  });

  test("parses title, authors and year", async () => {
    stub({ "export.arxiv.org": arxivFeed });
    expect(await lookupArxiv("2401.00001v2")).toEqual({
      title: "Arxiv Paper",
      authors: ["Frank"],
      year: 2020,
    });
  });

  test("returns null on rate limiting", async () => {
    stub({ "export.arxiv.org": () => text("Rate exceeded") });
    expect(await lookupArxiv("2401.00002")).toBeNull();
  });

  test("returns null on an HTTP error", async () => {
    stub({ "export.arxiv.org": () => text("", 500) });
    expect(await lookupArxiv("2401.00003")).toBeNull();
  });
});
