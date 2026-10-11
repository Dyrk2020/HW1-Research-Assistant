---
name: paper-read
description: Structured academic paper reading in three depths (Survey/Read/Compare). Use when the user wants to read, summarize, extract innovations from, or compare papers (PDF). Anti-hallucination source tagging required.
---

# Paper Reading (Survey / Read / Compare)

Three depths. Pick by user purpose; default to Survey, escalate on request.

## Depth 1 — Survey (quick, ~10s)

Output: 1-sentence contribution + up to 3 innovations + `[p.X]` anchors.

## Depth 2 — Read (standard, recommended)

Six sections, in order:

1. **Basis**: title, authors, affiliations, venue, year, DOI, keywords.
2. **Abstract + plain explanation**: faithful translation/paraphrase + 3–5 sentences for a non-expert.
3. **Background**: problem + why it matters.
4. **Method** (pick template by paper type):
   - AI/deep learning: task I/O, architecture, training, inference.
   - Algorithms/theory: formalization, steps, complexity, key assumptions.
   - Systems: architecture, components, metrics, comparison.
   - Empirical: design, data collection, statistics.
   - Survey: scope, taxonomy, comparison dimensions.
5. **Innovations** (max 5): each bound to source location.
6. **Results + limitations**: concrete numbers vs baselines; separate author-stated vs model-identified limits.

## Depth 3 — Compare (extended + syntopical)

Depth 2 + self-citation lineage (from references only, no external lookup) +
baseline diff table (ours vs baseline1/2: what differs, which table row proves it).
Align terminology before comparing.

## Anti-hallucination (mandatory)

- `[原文声明]` + evidence `Section X, "quote..."` vs `[模型归纳]` + basis.
- Missing field → `[未明确给出]`, never guess. Ambiguous → `[不确定]` + why.
- Every innovation/claim carries a `[p.X]` page anchor for the right-pane PDF jump.

## Reading method (Keshav three-pass)

- Pass 1: title, abstract, intro, headings, conclusion, references → gist.
- Pass 2: read evidence closely; mark proofs/derivations needing attention.
- Pass 3 (only sections that matter): reconstruct method independently, then compare.
- Keep methods / results / authors' interpretation in separate columns.
