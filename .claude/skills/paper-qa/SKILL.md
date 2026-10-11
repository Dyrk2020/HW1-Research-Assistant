---
name: paper-qa
description: Answer natural-language questions about a paper from retrieved evidence only. Use when the user asks anything about a saved paper (problem, idea, datasets, limitations, baselines). Every sentence traceable to a page anchor.
---

# Paper QA (evidence-only)

## Retrieval first

1. FTS (`papers_fts MATCH`) coarse pass over sections/claims/figures.
2. Vector (`vec_distance_cosine`) fine pass, top 20 chunks.
3. Feed only retrieved chunks + figure captions to the LLM. Never answer from title/metadata alone.

## Answer rules

- Every factual sentence ends with `[p.X]` (or `[p.X Fig.Y]`).
- No source → say `[未明确给出]`, do not invent.
- Separate: what the paper states vs what you infer (`[原文声明]` / `[模型归纳]`).
- For comparisons: name the baseline, cite the table/figure row that proves the gap.

## Output

- Direct answer first (with anchors), then 1-line "evidence" list mapping each anchor to its section.
- Follow-up: offer one deeper question (e.g. "要看消融表 p.6 吗?").
