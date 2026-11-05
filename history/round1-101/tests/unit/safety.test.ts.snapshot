import { describe, expect, test } from "bun:test";
import { MAX_DOWNLOAD_MB, isPublicHttpUrl, safePdfPath } from "../../lib/safety.ts";

describe("isPublicHttpUrl", () => {
  test("accepts public http(s) URLs", () => {
    expect(isPublicHttpUrl("https://example.com/paper.pdf")).toBe(true);
    expect(isPublicHttpUrl("http://arxiv.org/pdf/1706.03762")).toBe(true);
    expect(isPublicHttpUrl("https://purdue.brightspace.com/d2l/home")).toBe(true);
  });

  test("rejects non-http schemes", () => {
    for (const u of ["ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x"]) {
      expect(isPublicHttpUrl(u)).toBe(false);
    }
  });

  test("rejects loopback, RFC1918 and link-local hosts", () => {
    for (const u of [
      "http://localhost:4321/",
      "http://LOCALHOST/x",
      "http://127.0.0.1/x",
      "http://10.0.0.5/x",
      "http://192.168.1.1/x",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      expect(isPublicHttpUrl(u)).toBe(false);
    }
  });

  test("rejects IPv6 loopback", () => {
    expect(isPublicHttpUrl("http://[::1]/")).toBe(false);
    expect(isPublicHttpUrl("http://[::1]:8080/x")).toBe(false);
  });

  test("rejects the cloud metadata hostname", () => {
    expect(isPublicHttpUrl("http://metadata.google.internal/computeMetadata/v1")).toBe(false);
  });

  test("rejects malformed input", () => {
    for (const u of ["", "not a url", "http://", "https://", "//example.com"]) {
      expect(isPublicHttpUrl(u)).toBe(false);
    }
  });

  test("ignores userinfo when checking the authority", () => {
    expect(isPublicHttpUrl("http://user:pass@127.0.0.1/x")).toBe(false);
  });

  test("normalizes decimal and octal loopback forms", () => {
    expect(isPublicHttpUrl("http://2130706433/")).toBe(false);
    expect(isPublicHttpUrl("http://0177.0.0.1/")).toBe(false);
  });
});

describe("safePdfPath", () => {
  const base = "/tmp/hw2-base";

  test("joins a plain file", () => {
    expect(safePdfPath(base, "paper.pdf")).toBe("/tmp/hw2-base/paper.pdf");
  });

  test("allows nested subdirectories", () => {
    expect(safePdfPath(base, "sub/paper.pdf")).toBe("/tmp/hw2-base/sub/paper.pdf");
  });

  test("accepts an upper-case extension", () => {
    expect(safePdfPath(base, "PAPER.PDF")).toBe("/tmp/hw2-base/PAPER.PDF");
  });

  test("rejects traversal", () => {
    expect(safePdfPath(base, "../escape.pdf")).toBeNull();
    expect(safePdfPath(base, "sub/../../escape.pdf")).toBeNull();
  });

  test("rejects absolute paths", () => {
    expect(safePdfPath(base, "/etc/passwd")).toBeNull();
  });

  test("rejects non-pdf names", () => {
    expect(safePdfPath(base, "notes.txt")).toBeNull();
    expect(safePdfPath(base, "x.pdf.exe")).toBeNull();
  });
});

test("download cap is 75 MB", () => {
  expect(MAX_DOWNLOAD_MB).toBe(75);
});
