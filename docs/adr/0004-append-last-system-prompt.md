# ADR-0004: Append Memory Block Last in System Prompt (push, not unshift)

## Status

Accepted

## Context

OpenCode builds the system prompt as an array `output.system: string[]`. The first element (`system[0]`) is OpenCode's main system prompt — it is large and stable across requests. LLM providers (Anthropic, OpenAI) use prompt caching keyed on the prefix of the prompt. If `system[0]` changes between requests, the cache is invalidated and the full prompt is re-tokenized and re-priced.

The memory block injected by this plugin changes on every request (different memories are retrieved). Inserting the memory block before `system[0]` (via `unshift`) would shift the stable content to a different position, invalidating the cache on every call.

## Decision

Always append the memory block as the last element of `output.system[]` using `push`:

```typescript
output.system.push(memoryBlock.text)  // append last, never unshift
```

## Consequences

- **Positive**: `system[0]` (OpenCode's main prompt) remains unchanged across requests → prompt cache hits preserved.
- **Positive**: Reduces LLM API costs and latency for cached prefixes.
- **Neutral**: The memory block appears after the main system prompt. LLMs process all system prompt segments regardless of order; placement at the end is semantically equivalent.
- **Negative**: None identified. The append-last position has no known drawbacks for memory injection use cases.
