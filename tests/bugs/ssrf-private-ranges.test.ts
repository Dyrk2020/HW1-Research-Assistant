import { test, expect } from "bun:test";
import { isPublicHttpUrl } from "../../lib/safety.ts";

// test.failing pins a defect: the assertion describes the required behavior,
// the suite stays green while the bug is open, and the test flips to a normal
// passing test the moment the guard is fixed.
test.failing("BUG: 172.16.0.0/12 private range must be blocked", () => {
  expect(isPublicHttpUrl("http://172.16.0.1/")).toBe(false);
});

test.failing("BUG: 100.64.0.0/10 CGNAT range must be blocked", () => {
  expect(isPublicHttpUrl("http://100.64.0.1/")).toBe(false);
});

test.failing("BUG: 0.0.0.0 must be blocked", () => {
  expect(isPublicHttpUrl("http://0.0.0.0/")).toBe(false);
});

test.failing("BUG: IPv4-mapped IPv6 loopback must be blocked", () => {
  expect(isPublicHttpUrl("http://[::ffff:127.0.0.1]/")).toBe(false);
});

test.failing("BUG: IPv6 ULA and link-local ranges must be blocked", () => {
  expect(isPublicHttpUrl("http://[fc00::1]/")).toBe(false);
  expect(isPublicHttpUrl("http://[fe80::1]/")).toBe(false);
});
