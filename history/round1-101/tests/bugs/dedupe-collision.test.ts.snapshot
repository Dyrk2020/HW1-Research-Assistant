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

test.failing("BUG: titles that diverge after the twelfth token collapse into one", () => {
  const partOne = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Part One";
  const partTwo = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Part Two";

  expect(dedupeKey(partOne)).not.toBe(dedupeKey(partTwo));
  expect(mergePapers([[make(partOne)], [make(partTwo)]])).toHaveLength(2);
});
