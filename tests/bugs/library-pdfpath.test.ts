import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type TestServer } from "../helpers/server.ts";

let server: TestServer;
let dir = "";
let secretPath = "";

beforeAll(async () => {
  server = await startServer();
  dir = await mkdtemp(join(tmpdir(), "hw2-secret-"));
  secretPath = join(dir, "secret.txt");
  await writeFile(secretPath, "TOP-SECRET-MARKER");
});

afterAll(async () => {
  await server.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test.failing("BUG: /api/pdf serves a client-supplied pdfPath outside the managed directory", async () => {
  const created = await fetch(server.url + "/api/library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "evil",
      title: "Imported Path",
      authors: [],
      year: null,
      abstract: "",
      link: "",
      source: "test",
      pdfPath: secretPath,
    }),
  });
  // A fix may reject the import at POST time; either 400 here or a sanitized
  // 201 followed by a 404 on serve satisfies the requirement.
  if (created.status === 400) return;
  expect(created.status).toBe(201);
  expect((await created.json()).paper.pdfPath).toBeNull();

  const served = await fetch(server.url + "/api/pdf/evil");
  expect(served.status).toBe(404);
});
