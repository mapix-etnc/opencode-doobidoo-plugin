# ADR-0002: Skip Memory Inject for Subagent Sessions

## Status

Accepted

## Context

OpenCode spawns subagent sessions (e.g. `explore`, `codebase-analyzer`, `executor`) for delegated subtasks. These sessions have `session.parentID` set. Subagents receive explicit, narrow instructions from the orchestrating agent — they are given exactly the context they need to execute a specific task.

See also: `Specs/no-inject-for-subagents.md`

## Decision

In `system.transform`, check `session.parentID`. If it is set, skip memory injection entirely for that session.

```typescript
if (session.parentID) return output  // subagent — skip
```

## Consequences

- **Positive**: Subagents are not confused by general memory context that is irrelevant to their narrow task.
- **Positive**: Avoids conflicts between the orchestrator's injected instructions and additional injected memories.
- **Positive**: Reduces token usage for subagent calls.
- **Negative**: Subagents cannot benefit from memory context even in cases where it might be useful. This is accepted as the safer default — subagents that need memory context should receive it explicitly from the orchestrator.
