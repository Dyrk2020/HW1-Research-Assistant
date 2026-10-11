---
name: citation-check
description: Anchor a paper's claims against real citation data. Use when checking novelty, baselines, or research lineage. Resolves references via Semantic Scholar / OpenAlex and similar papers via Exa.
---

# Citation Check (anchor novelty to reality)

## Steps

1. Extract `baselines[]` + `references[]` from the paper (structured extract, with pages).
2. Resolve each via Semantic Scholar / OpenAlex (`references + citations`):
   - `GET https://api.semanticscholar.org/graph/v1/paper/{id}?fields=title,authors,year,references,citations`
   - `GET https://api.openalex.org/works/{id}`
3. Find similar papers: Exa `category=publication`, query = method description (not title keywords).
4. Self-citation scan: match author surnames in references → lineage note (internal only).

## Output

- Baseline table: claimed baseline → resolved paper ID/title/year → matched or `[未找到，小心幻觉]`.
- Novelty verdict: what differs vs each baseline + proving evidence `[p.X]`.
- Never present an unresolved baseline as fact.
