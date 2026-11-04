import { describe, expect, test } from "bun:test";
import { probePdf } from "../../lib/pdf.ts";
import { makePdf } from "../helpers/pdf.ts";

describe("probePdf", () => {
  test("extracts text, title and page count", async () => {
    const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const probe = await probePdf(makePdf({ pages: [text], title: "A Test Paper" }));

    expect(probe.pageCount).toBe(1);
    expect(probe.title).toBe("A Test Paper");
    expect(probe.text).toContain("word0");
    expect(probe.text).toContain("word29");
    expect(probe.extractionStatus).toBe("text_extracted");
    expect(probe.pagesWithoutText).toEqual([]);
  });

  test("flags a sparse page as partial_text", async () => {
    const probe = await probePdf(makePdf({ pages: ["one two three four five"] }));

    expect(probe.text).toBe("one two three four five");
    expect(probe.extractionStatus).toBe("partial_text");
  });

  test("flags image-only pages as no_text and lists every page", async () => {
    const probe = await probePdf(makePdf({ pages: ["a", "b"], noTextOps: true }));

    expect(probe.pageCount).toBe(2);
    expect(probe.text).toBe("");
    expect(probe.extractionStatus).toBe("no_text");
    expect(probe.pagesWithoutText).toEqual([1, 2]);
  });

  test("counts multiple pages", async () => {
    const page = Array.from({ length: 25 }, (_, i) => `t${i}`).join(" ");
    const probe = await probePdf(makePdf({ pages: [page, page] }));

    expect(probe.pageCount).toBe(2);
    expect(probe.extractionStatus).toBe("text_extracted");
  });

  test("returns a safe probe for empty bytes", async () => {
    const probe = await probePdf(new Uint8Array());
    expect(probe).toEqual({
      pageCount: null,
      text: "",
      extractionStatus: "no_text",
      pagesWithoutText: [],
      title: null,
    });
  });

  test("does not throw on a truncated header", async () => {
    const probe = await probePdf(new TextEncoder().encode("%PDF-1.4\n"));
    expect(probe.pageCount).toBeNull();
    expect(probe.text).toBe("");
    expect(probe.extractionStatus).toBe("no_text");
  });

  test("returns a safe probe for non-PDF bytes", async () => {
    const probe = await probePdf(new TextEncoder().encode("not a pdf"));

    expect(probe).toEqual({
      pageCount: null,
      text: "",
      extractionStatus: "no_text",
      pagesWithoutText: [],
      title: null,
    });
  });

  test("extracts TJ arrays mixing literal and hex strings", async () => {
    const probe = await probePdf(makePdf({ rawStreams: ["BT /F1 12 Tf [(Hello) <776f726c64>] TJ ET"] }));

    expect(probe.text).toBe("Hello world");
  });

  test("decodes octal escapes inside literal strings", async () => {
    const probe = await probePdf(makePdf({ rawStreams: ["BT /F1 12 Tf (Hello \\101\\102\\103) Tj ET"] }));

    expect(probe.text).toBe("Hello ABC");
  });

  test("falls back to raw DEFLATE when zlib framing is absent", async () => {
    const words = Array.from({ length: 25 }, (_, i) => `raw${i}`).join(" ");
    const probe = await probePdf(makePdf({ rawStreams: [`BT /F1 12 Tf (${words}) Tj ET`], rawDeflate: true }));

    expect(probe.text).toContain("raw0");
    expect(probe.extractionStatus).toBe("text_extracted");
  });

  test("ignores content streams that are neither zlib nor raw DEFLATE", async () => {
    const probe = await probePdf(makePdf({ rawStreams: ["BT /F1 12 Tf (plain) Tj ET"], plainStream: true }));

    expect(probe.text).toBe("");
    expect(probe.extractionStatus).toBe("no_text");
  });
});
