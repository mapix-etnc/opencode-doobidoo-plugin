# ADR-0006: Use MS-MARCO Instead of DeBERTa for Quality Scoring

## Status

Accepted (2026-05-08)

## Context

The doobidoo memory server (`mcp-memory-service`) supports ONNX-based quality scoring for memory entries. The default configuration included two models:

- **DeBERTa** (`nvidia/quality-classifier-deberta`, 712 MB) — general text quality classifier trained on web and academic text (Wikipedia, news, publications).
- **MS-MARCO** (`cross-encoder/ms-marco-MiniLM-L-6-v2`, ~22 MB) — cross-encoder trained on query-document relevance pairs from real-world search.

In production, DeBERTa produced uninformative scores for agent memory snippets (short technical notes, findings, configuration snippets). **Measured DeBERTa scores for agent snippets: 0.03–0.10** — practically constant regardless of actual entry value. This is expected: DeBERTa's training domain (long-form natural language) does not match agent snippets.

Impact: `quality_score < 0.5` → retention tier "low" (30–90 days). With DeBERTa, all entries scored below 0.1, classifying everything as low-quality.

## Decision

Switch to MS-MARCO as the sole quality scoring model with `MCP_QUALITY_FALLBACK_ENABLED=false`.

Final configuration:
```bash
MCP_QUALITY_SYSTEM_ENABLED=true
MCP_QUALITY_AI_PROVIDER=local
MCP_QUALITY_LOCAL_MODEL="ms-marco-MiniLM-L-6-v2"
MCP_QUALITY_LOCAL_DEVICE=auto
MCP_QUALITY_FALLBACK_ENABLED=false   # no DeBERTa fallback
MCP_QUALITY_BOOST_ENABLED=true       # rescore on every retrieve
```

`FALLBACK_ENABLED=false` is required — without it, the library may silently switch back to DeBERTa if MS-MARCO is unavailable.

## Consequences

- **Positive**: MS-MARCO is query-aware — scores reflect relevance to the actual query, which matches the use case (memory relevance depends on context, not absolute text quality).
- **Positive**: 22 MB vs. 712 MB; ~44 MB RAM vs. ~1.4 GB.
- **Positive**: Measured retrieve-time scores with real queries: avg 0.35, 23% entries ≥ 0.7.
- **Accepted trade-off**: Store-time score is always 0.0 (MS-MARCO requires a real query; `query=""` at store time returns 0.0). This is acceptable because:
  - `retrieve_memory()` ranks primarily by embedding distance (`e.distance`), not `quality_score`.
  - `MCP_QUALITY_BOOST_ENABLED=true` rescores on every retrieve with the real query.
  - The forgetting pipeline is disabled by default (`MCP_FORGETTING_ENABLED=false`).
- **Action required after migration or bulk import**: Run `scripts/rescore.py` to replace store-time 0.0 scores with real scores before enabling the forgetting pipeline.

| Aspect | DeBERTa | MS-MARCO |
|--------|---------|----------|
| Model size | 712 MB | ~22 MB |
| Store-time score | 0.03–0.10 (uninformative) | 0.0 (no query) |
| Retrieve-time score | 0.03–0.10 (uninformative) | 0.0–1.0 (query-aware) |
| Fit for agent snippets | Poor | Good |
