import { expect, test } from "bun:test";
import { dedupeKey, mergePapers } from "../../lib/search.ts";
import type { Paper } from "../../lib/db.ts";

const make = (title: string): Paper => ({
  id: title.slice(0, 8),
  title,
  authors: [],
  year: null,
  abstract: "",
  link: "",
  source: "test",
  pdfPath: null,
  createdAt: 0,
});

test.failing("BUG: the 8-token head merges two distinct titles that share only that head", () => {
  const partOne = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa";
  const partTwo = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Lambda";

  expect(dedupeKey(partOne)).not.toBe(dedupeKey(partTwo));
  expect(mergePapers([[make(partOne)], [make(partTwo)]])).toHaveLength(2);
});
