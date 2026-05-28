# ADR-0005: 10,000-Character System Prompt Threshold for Internal LLM Call Detection

## Status

Accepted

## Context

OpenCode makes internal LLM calls for housekeeping tasks such as session title generation. These calls have short system prompts (typically a few hundred characters). User-facing sessions have system prompts that include OpenCode's full main prompt — which is several thousand characters long.

There is no explicit API flag or session type marker to distinguish internal LLM calls from user sessions. Injecting memories into internal calls is wasteful (adds tokens to calls that don't need context) and potentially harmful (could interfere with title generation or other internal tasks).

## Decision

In `system.transform`, skip memory injection if the current system prompt is shorter than 10,000 characters:

```typescript
if (output.system.join("").length < 10_000) return output  // internal LLM call — skip
```

**Harness implication**: The test harness must use a fake system prompt of ≥ 10,001 characters to ensure the inject path is exercised in tests.

## Consequences

- **Positive**: Clean, zero-coupling detection of internal calls without requiring upstream API changes.
- **Positive**: Works correctly today and will continue to work as long as OpenCode's main system prompt remains above 10,000 characters (currently ~20,000+ characters).
- **Negative**: Fragile if OpenCode's main system prompt were to shrink below 10,000 characters. This is considered unlikely given the prompt contains extensive tool definitions, but should be verified after major OpenCode upgrades.
- **Negative**: Not semantically meaningful — the threshold is an empirical proxy, not a formal contract. A future OpenCode API version may provide an explicit `isInternalCall` flag, at which point this heuristic should be replaced.
