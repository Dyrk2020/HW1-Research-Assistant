import { Database } from "bun:sqlite";
import { join } from "node:path";

export type ExtractionStatus = "text_extracted" | "partial_text" | "no_text" | "not_applicable";

export type Paper = {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  abstract: string;
  link: string;
  source: string;
  pdfPath: string | null;
  createdAt: number;
  extractionStatus?: ExtractionStatus;
  pagesWithoutText?: number[];
  pageCount?: number | null;
};

const dbPath = process.env.DB_PATH ?? join(import.meta.dir, "papers.db");
export const db = new Database(dbPath, { create: true });

db.run(`
CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  authors TEXT NOT NULL,
  year INTEGER,
  abstract TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  pdf_path TEXT,
  created_at INTEGER NOT NULL,
  extraction_status TEXT NOT NULL DEFAULT 'not_applicable',
  pages_without_text TEXT NOT NULL DEFAULT '[]',
  page_count INTEGER
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_papers_created ON papers(created_at DESC)`);
// Standalone FTS5 index (no external-content triggers: papers has TEXT PK, not INTEGER rowid)
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(id UNINDEXED, title, abstract)`);
for (const ddl of [
  `ALTER TABLE papers ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'not_applicable'`,
  `ALTER TABLE papers ADD COLUMN pages_without_text TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE papers ADD COLUMN page_count INTEGER`,
]) {
  try {
    db.run(ddl);
  } catch {
    // column already exists on migrated DBs
  }
}
type PaperRow = {
  id: string;
  title: string;
  authors: string;
  year: number | null;
  abstract: string;
  link: string;
  source: string;
  pdf_path: string | null;
  created_at: number;
  extraction_status: ExtractionStatus;
  pages_without_text: string;
  page_count: number | null;
};

function rowToPaper(r: PaperRow): Paper {
  return {
    id: r.id,
    title: r.title,
    authors: JSON.parse(r.authors) as string[],
    year: r.year,
    abstract: r.abstract,
    link: r.link,
    source: r.source,
    pdfPath: r.pdf_path,
    extractionStatus: r.extraction_status,
    pagesWithoutText: JSON.parse(r.pages_without_text) as number[],
    pageCount: r.page_count,
  };
}

export function savePaper(p: Omit<Paper, "createdAt"> & { createdAt?: number }): Paper {
  const paper: Paper = {
    extractionStatus: "not_applicable",
    pagesWithoutText: [],
    pageCount: null,
    ...p,
    createdAt: p.createdAt ?? Date.now(),
  };
  db.run(
    `INSERT OR REPLACE INTO papers (id,title,authors,year,abstract,link,source,pdf_path,created_at,extraction_status,pages_without_text,page_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [paper.id, paper.title, JSON.stringify(paper.authors), paper.year, paper.abstract, paper.link, paper.source, paper.pdfPath, paper.createdAt, paper.extractionStatus, JSON.stringify(paper.pagesWithoutText), paper.pageCount],
  );
  db.run(`DELETE FROM papers_fts WHERE id=?`, [paper.id]);
  db.run(`INSERT INTO papers_fts(id,title,abstract) VALUES (?,?,?)`, [paper.id, paper.title, paper.abstract]);
  return paper;
}

export function listPapers(): Paper[] {
  const rows = db.query(`SELECT * FROM papers ORDER BY created_at DESC`).all() as unknown as PaperRow[];
  return rows.map(rowToPaper);
}

export function getPaper(id: string): Paper | null {
  const r = db.query(`SELECT * FROM papers WHERE id=?`).get(id) as unknown as PaperRow | null;
  return r ? rowToPaper(r) : null;
}

export function deletePaper(id: string): void {
  db.run(`DELETE FROM papers_fts WHERE id=?`, [id]);
  db.run(`DELETE FROM papers WHERE id=?`, [id]);
}
