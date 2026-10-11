// Pure-TS PDF text layer: no Python, no native dep.
// Decodes FlateDecode streams via DecompressionStream, pulls Tj/TJ text ops,
// counts pages via /Type /Page markers, reports extractionStatus like
// paper-pilot's deep_read (text_extracted | partial_text | no_text).

import type { ExtractionStatus } from "./db.ts";

export type PdfProbe = {
  pageCount: number | null;
  text: string;
  extractionStatus: ExtractionStatus;
  pagesWithoutText: number[];
  title: string | null;
};

function latin1ToText(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

async function inflateStream(data: Uint8Array): Promise<Uint8Array | null> {
  for (const format of ["deflate", "deflate-raw"] as const) {
    try {
      const ds = new DecompressionStream(format);
      const buf = await new Response(new Blob([data as BlobPart]).stream().pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(buf);
    } catch {
      continue;
    }
  }
  return null;
}

function unescapePdfString(s: string): string {
  return s
    .replace(/\\([nrtbf()\\])/g, "$1")
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

function extractStrings(decoded: string): string {
  const parts: string[] = [];
  const tjRe = /\((?:\\.|[^\\()]+)*\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = tjRe.exec(decoded)) !== null) {
    parts.push(unescapePdfString(m[0].slice(1, m[0].lastIndexOf(")"))));
  }
  const tjArr = /\[(?:[^\[\]]*)\]\s*TJ/g;
  while ((m = tjArr.exec(decoded)) !== null) {
    const inner = m[0].match(/\((?:\\.|[^\\()]+)*\)|<[0-9a-fA-F]+>/g) ?? [];
    for (const s of inner) {
      if (s.startsWith("<")) {
        const hex = s.slice(1, -1).replace(/\s+/g, "");
        let out = "";
        for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        parts.push(out);
      } else {
        parts.push(unescapePdfString(s.slice(1, -1)));
      }
    }
  }
  return parts.join(" ");
}

export async function probePdf(buf: Uint8Array): Promise<PdfProbe> {
  const raw = latin1ToText(buf);
  const titleMatch = raw.match(/\/Title\s*\(([^)]+)\)/);
  const pageCount = (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length || null;

  const streams: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw)) !== null) {
    streams.push(m[1] ?? "");
  }

  const chunks: string[] = [];
  for (const s of streams.slice(0, 400)) {
    const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
    const inflated = await inflateStream(bytes);
    if (!inflated) continue;
    const decoded = latin1ToText(inflated);
    if (!decoded.includes("Tj") && !decoded.includes("TJ")) continue;
    chunks.push(extractStrings(decoded));
  }
  const text = chunks
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const words = text ? text.split(" ").length : 0;
  const pages = pageCount ?? 1;
  const wordsPerPage = words / pages;
  const extractionStatus: ExtractionStatus = words === 0 ? "no_text" : wordsPerPage < 20 ? "partial_text" : "text_extracted";
  return {
    pageCount,
    text,
    extractionStatus,
    pagesWithoutText: extractionStatus === "no_text" && pageCount ? Array.from({ length: pageCount }, (_, i) => i + 1) : [],
    title: titleMatch?.[1]?.trim() || null,
  };
}
