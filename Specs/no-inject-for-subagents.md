# Spec: Skip memory inject for subagents

## Problem
Memories are injected into all sessions including subagents spawned via Task tool.
Subagents have explicit instructions and don't benefit from memory context.
This wastes tokens on redundant payload.

## Solution
Check `session.parentID` in `system.transform` hook. If present, skip inject.

## Implementation

### Detection
Use `client.session.get({ path: { id: sessionId } })` to retrieve session info.
Session has `parentID` field iff it's a subagent (child session).

### Code Change
In `experimental.chat.system.transform` hook (plugin.ts:546):

```typescript
const sessionId = (input as { sessionID?: string }).sessionID
if (!sessionId) return

// Skip subagents - they have explicit instructions and don't need memories
try {
  const sessionInfo = await client.session.get({ path: { id: sessionId } })
  if (sessionInfo.data?.parentID) {
    await client.app.log({
      body: {
        service: "doobidoo-memory",
        level: "info",
        message: `Skipping memory inject for subagent session ${sessionId}`,
      },
    })
    return
  }
} catch (err) {
  // Failed to get session info - proceed with inject (fail open)
  await client.app.log({
    body: {
      service: "doobidoo-memory",
      level: "warn",
      message: `Failed to check subagent status: ${err}`,
    },
  })
}

// ... existing skip logic (MIN_CHAT_SYSTEM_CHARS check, pendingMemoryBlock check)
```

### Files
- `src/plugin.ts` — modify `system.transform` hook

### Caching (optional optimization)
Add `isSubagent: boolean | undefined` to sessionState:
- Set on first check in `system.transform`
- Reuse in subsequent calls
- Reset when sessionState is deleted (session.idle)

## Testing
- Harness: add scenario `inject-subagent` (verify no inject for subagent)
- Manual: run Task tool, check logs for `[MEMORY] inject` — should NOT appear for subagent sessions

## Edge Cases
- Session info fetch fails → proceed with inject (fail open)
- Subagent session that later becomes parent → not applicable (subagent sessions don't spawn children)
- Compaction in subagent → should also skip (system.transform handles this)
