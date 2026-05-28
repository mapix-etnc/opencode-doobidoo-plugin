# ADR-0001: Two-Phase Memory Inject Pipeline

## Status

Accepted

## Context

The OpenCode plugin API exposes two separate hook points that are relevant for memory injection:

- `experimental.chat.messages.transform` — has access to the full message list (user prompt text)
- `experimental.chat.system.transform` — has access to `output.system` (the system prompt array)

A single hook cannot do both: reading the user prompt text and appending to the system prompt require different hook entry points. The ordering of these hooks is guaranteed by OpenCode (messages before system).

## Decision

Implement memory injection as a two-phase pipeline:

1. **Phase 1 — `messages.transform`**: Extract user prompt text, search doobidoo, build the memory block, store result in `sessionState[sessionId].pendingMemoryBlock`.
2. **Phase 2 — `system.transform`**: Read `pendingMemoryBlock` from session state, append it to `output.system[]`, clear the state.

## Consequences

- **Positive**: Clean separation of concerns — search logic in messages hook, injection logic in system hook.
- **Positive**: Hook ordering is guaranteed by OpenCode; no race conditions.
- **Positive**: If Phase 1 finds nothing (or is skipped by a guard), Phase 2 simply finds `pendingMemoryBlock === null` and does nothing — no coupling needed.
- **Negative**: State must be passed between hooks via `sessionState` map — adds a shared mutable data structure.
- **Negative**: Cannot merge into a single hook; merging would require API changes upstream in OpenCode.
