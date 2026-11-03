// Minimal PDF builder for probePdf tests: one FlateDecode content stream per page.
import { deflateRawSync, deflateSync } from "node:zlib";

export type PdfOptions = {
  pages?: string[];
  title?: string | null;
  noTextOps?: boolean;
  /** Raw (already valid PDF operators) content streams, one per page. */
  rawStreams?: string[];
  /** Compress with raw DEFLATE instead of zlib-wrapped DEFLATE. */
  rawDeflate?: boolean;
  /** Emit the stream body verbatim with no compression. */
  plainStream?: boolean;
};

export function makePdf(opts: PdfOptions = {}): Uint8Array {
  const contents = opts.rawStreams ?? opts.pages ?? ["Hello world"];
  const n = contents.length;
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];

  parts.push(Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));
  const kids = contents.map((_, i) => `${3 + i} 0 R`).join(" ");
  parts.push(Buffer.from(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`));

  for (let i = 0; i < n; i++) {
    parts.push(Buffer.from(`${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${3 + n + i} 0 R >>\nendobj\n`));
  }

  for (let i = 0; i < n; i++) {
    const num = 3 + n + i;
    const raw = opts.rawStreams?.[i];
    const text = contents[i] ?? "";
    const escaped = text.replace(/([()\\])/g, "\\$1");
    const stream =
      raw !== undefined
        ? Buffer.from(raw, "latin1")
        : opts.noTextOps
          ? Buffer.from("q Q")
          : Buffer.from(`BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`);
    const body = opts.plainStream ? stream : opts.rawDeflate ? deflateRawSync(stream) : deflateSync(stream);
    const filter = opts.plainStream ? "" : " /Filter /FlateDecode";
    parts.push(Buffer.from(`${num} 0 obj\n<< /Length ${body.length}${filter} >>\nstream\n`));
    parts.push(body);
    parts.push(Buffer.from("\nendstream\nendobj\n"));
  }

  const infoNum = 3 + 2 * n;
  if (opts.title) parts.push(Buffer.from(`${infoNum} 0 obj\n<< /Title (${opts.title}) >>\nendobj\n`));
  const infoRef = opts.title ? ` /Info ${infoNum} 0 R` : "";
  parts.push(Buffer.from(`trailer\n<< /Root 1 0 R${infoRef} /Size ${infoNum + 1} >>\n%%EOF\n`));

  return new Uint8Array(Buffer.concat(parts));
}
