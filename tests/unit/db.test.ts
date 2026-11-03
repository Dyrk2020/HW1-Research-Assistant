import { describe, expect, test } from "bun:test";
import { db, deletePaper, getPaper, listPapers, savePaper } from "../../lib/db.ts";

// One process-wide test DB is configured by tests/setup.ts; rows are namespaced
// so this file never collides with route tests running in the same registry.
const base = {
  authors: ["Ada", "Grace"],
  year: 2024,
  abstract: "generic abstract",
  link: "https://example.com/p",
  source: "test",
  pdfPath: null,
};

describe("library persistence", () => {
  test("save then get round-trips persisted fields", () => {
    const saved = savePaper({
      ...base,
      id: "dbt-p1",
      title: "Paper One",
      abstract: "dbtquantum retrieval",
      extractionStatus: "text_extracted",
      pagesWithoutText: [2],
      pageCount: 7,
      createdAt: 1_000,
    });
    const { createdAt: _ignored, ...roundtrip } = saved;
    expect(getPaper("dbt-p1")).toEqual(roundtrip);
    expect(getPaper("dbt-p1")?.authors).toEqual(["Ada", "Grace"]);
  });

  // test.failing pins the defect; remove the wrapper once rowToPaper returns createdAt.
  test.failing("BUG: getPaper drops createdAt even though Paper declares it", () => {
    expect(getPaper("dbt-p1")?.createdAt).toBe(1_000);
  });

  test("missing id returns null", () => {
    expect(getPaper("does-not-exist")).toBeNull();
  });

  test("list returns this file's rows newest first", () => {
    savePaper({ ...base, id: "dbt-p1", title: "Paper One", createdAt: 1_000 });
    savePaper({ ...base, id: "dbt-p2", title: "Paper Two", createdAt: 2_000 });
    savePaper({ ...base, id: "dbt-p3", title: "Paper Three", createdAt: 3_000 });
    const ids = listPapers()
      .map((p) => p.id)
      .filter((id) => ["dbt-p1", "dbt-p2", "dbt-p3"].includes(id));
    expect(ids).toEqual(["dbt-p3", "dbt-p2", "dbt-p1"]);
  });

  test("insert-or-replace keeps one row and reindexes FTS", () => {
    savePaper({ ...base, id: "dbt-p1", title: "Paper One Revised", abstract: "dbtupdated token", createdAt: 1_000 });
    expect(listPapers().filter((p) => p.id === "dbt-p1")).toHaveLength(1);
    expect(db.query("SELECT id FROM papers_fts WHERE papers_fts MATCH 'dbtupdated'").all()).toHaveLength(1);
    expect(db.query("SELECT id FROM papers_fts WHERE papers_fts MATCH 'dbtquantum'").all()).toHaveLength(0);
  });

  test("delete removes the row and its FTS entry", () => {
    deletePaper("dbt-p2");
    expect(getPaper("dbt-p2")).toBeNull();
    expect(db.query("SELECT id FROM papers_fts WHERE id = ?").all("dbt-p2")).toHaveLength(0);
  });

  test("json columns survive quotes, unicode and newlines", () => {
    savePaper({
      ...base,
      id: "dbt-p4",
      title: 'Quotes "and" (parens)',
      authors: ["O'Brien", "Åsa"],
      abstract: "line\nbreak",
      createdAt: 4_000,
    });
    expect(getPaper("dbt-p4")?.authors).toEqual(["O'Brien", "Åsa"]);
    expect(getPaper("dbt-p4")?.abstract).toBe("line\nbreak");
  });
});
