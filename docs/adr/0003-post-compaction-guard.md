# ADR-0003: Post-Compaction Memory Inject Guard

## Status

Accepted

## Context

When the OpenCode session context window approaches its limit, a compaction is triggered. The compaction LLM call produces a summary of the session. Immediately after compaction, the session state contains: the compaction summary + recent messages. If memory inject runs at this point, it adds more tokens to an already near-limit context, which can push the total over the limit and trigger a second compaction — creating an infinite loop.

The `experimental.session.compacting` hook sets a flag before compaction begins. The `session.idle` hook extracts lessons from the compaction summary after it completes.

## Decision

Introduce a `pendingLessonsExtraction` boolean flag in session state. The `compacting` hook sets it to `true`. The `system.transform` hook skips inject when this flag is `true`. The `session.idle` hook resets the flag to `false` after extracting lessons.

```typescript
if (state.pendingLessonsExtraction) return output  // post-compaction — skip
```

## Consequences

- **Positive**: Prevents the compaction → inject → over-limit → recompaction loop.
- **Positive**: The compaction summary itself serves as context for the next interaction; memory inject is redundant at this point.
- **Negative**: One interaction after compaction runs without injected memories. This is acceptable — the compaction summary provides sufficient context continuity.
- **Note**: The `pendingLessonsExtraction` flag also gates the `session.idle` handler to use Path A (lessons extraction) instead of Path B (normal summary), ensuring the two post-compaction actions are coordinated.
