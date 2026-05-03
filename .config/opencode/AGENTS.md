# opencode-doobidoo-plugin — Agent Guide

**Version:** 1.0.0  
**Runtime:** Bun ≥ 1.0  
**Plugin entry:** `src/plugin.ts`

---

## Project Purpose

OpenCode plugin that:
1. **Injects memories** into the system prompt before each LLM call (two-phase: `messages.transform` → `system.transform`)
2. **Saves session/conversation summaries** to the memory database on `session.idle`
3. **Extracts lessons** from compaction summaries via `experimental.session.compacting` + `session.idle`

Communicates with the **doobidoo mcp-memory-service** HTTP API (`http://localhost:8000/api` by default).

---

## Repository Structure

```
src/
  plugin.ts           ← single source file (DoobidooMemoryPlugin export)
scripts/
  harness.ts          ← local test harness (bun run scripts/harness.ts)
.config/
  opencode/
    AGENTS.md         ← this file
package.json
tsconfig.json
README.md
```

---

## Architecture: Key Design Decisions

### Two-phase inject (messages → system)

OpenCode calls hooks in guaranteed order: `messages.transform` → `system.transform` → LLM.

- **`messages.transform`**: extracts user query, calls doobidoo search, builds memory block, stores in `sessionState.pendingMemoryBlock`
- **`system.transform`**: reads `pendingMemoryBlock`, appends to `output.system[]`, clears state

This ordering guarantees the memory block is available when system prompt is assembled.

### Session state per sessionID

All per-session tracking lives in `sessionState: Map<string, {...}>`. Each session gets:
- `toolCalls[]` — for session summary
- `changedFiles: Set<string>` — distinguishes code sessions from conversation sessions
- `lastUserMessageText` — snapshot for session summary
- `pendingMemoryBlock` — populated in `messages.transform`, consumed in `system.transform`
- `lastInjectedQuery` — double-search guard (skip if same query repeated)
- `pendingLessonsExtraction` — flag set in compacting hook, consumed in next `session.idle`

### system.transform guard

`system.transform` skips internal LLM calls (title generator etc.) via:
```ts
const MIN_CHAT_SYSTEM_CHARS = 10_000
if (output.system.join("").length < MIN_CHAT_SYSTEM_CHARS) return
```
**Important for harness:** fake system prompt must be ≥ 10 000 chars.

### Non-synthetic message extraction

The beads plugin (and others) inject synthetic `user` messages at the end of the messages array.
The plugin searches backwards for the last user message with non-synthetic, non-empty text:
```ts
.filter(p => p.type === "text" && !p.synthetic)
```

---

## Configuration (env vars)

| Var | Default | Description |
|-----|---------|-------------|
| `DOOBIDOO_API_URL` | `http://localhost:8000/api` | doobidoo REST API base URL |
| `MEMORY_API_KEY` | read from `~/.config/opencode/secrets/memory-api-key` | Bearer auth token |
| `MEMORY_MIN_SCORE` | `0.55` | Minimum similarity score for semantic search results |
| `MEMORY_INJECT_LIMIT` | `7` | Max semantic memories injected per query |

Internal constants (not configurable via env, change in `plugin.ts`):

| Constant | Value | Description |
|----------|-------|-------------|
| `MEMORY_LESSONS_LIMIT` | `5` | Max lessons-learned memories |
| `MEMORY_IDENTITY_LIMIT` | `8` | Max identity/preference tag memories |
| `MEMORY_RECENT_LIMIT` | `5` | Recent session memories (fallback) |
| `MEMORY_FALLBACK_THRESHOLD` | `2` | Min semantic results before falling back to recent |
| `SESSION_MIN_TOOLS` | `2` | Min tool calls required to save session summary |
| `CONVERSATION_MIN_CHARS` | `300` | Min assistant text length to save conversation summary |

---

## Development Workflow

### Making changes

1. Edit `src/plugin.ts`
2. Run `bun run typecheck` — catches type errors in ~2s
3. Run `bun run scripts/harness.ts` — validates logic against live doobidoo
4. If harness passes → restart OpenCode to load the updated plugin
5. Commit

**Note: OpenCode caches the plugin in memory.** File changes on disk have no effect until OpenCode is restarted.

### Testing levels

| Level | Command | Speed | What it catches |
|-------|---------|-------|----------------|
| Typecheck | `bun run typecheck` | ~2s | Type errors, missing properties |
| Harness | `bun run harness` | ~5s | Logic bugs, inject pipeline, session saving |
| Integration | (future) | ~3s | HTTP layer, doobidoo API contract |
| Manual | restart OpenCode | ~2min | Hook registration, edge cases in real session |

---

## Harness: `scripts/harness.ts`

### Purpose

Simulates the OpenCode plugin runner locally — without restarting OpenCode.

- Imports `DoobidooMemoryPlugin` directly
- Creates a fake `client` (mocked: `app.log`, `tui.showToast`, `session.messages`)
- Calls hooks manually with test data
- Uses **live doobidoo API** for search (real results from real memory DB)
- Intercepts `POST /api/memories` to capture what would be stored (configurable: `--dry-run` skips actual write)

### Usage

```bash
bun run harness                    # run all scenarios
bun run harness inject             # run specific scenario by name
bun run harness --dry-run          # don't write anything to doobidoo
bun run harness inject --dry-run   # combine
```

### Scenarios

| Scenario | What it tests | Expected result |
|----------|--------------|-----------------|
| `inject` | Full inject pipeline: messages.transform → system.transform | Memory block appended to system prompt, toast shown |
| `guard` | Double-search guard | Second identical query skips search (pendingMemoryBlock = null) |
| `session` | Session with file edits → session_summary | Stores `session_summary` with tags `session`, `files-changed` |
| `conversation` | Conversation without files, long enough | Stores `conversation_summary` with tag `conversation` |
| `short` | Conversation too short (< 300 chars) | Nothing stored, log "content too short" |

### What harness does NOT test

- Hook registration correctness (requires real OpenCode)
- `experimental.session.compacting` (complex to simulate)
- Behavior when doobidoo is unreachable
- Plugin loading from `~/.config/opencode/plugins/`

### Output format

```
══════════════════════════════════════════════
 SCENARIO: inject — Normal message → inject memories
══════════════════════════════════════════════
Input: "jak funguje doobidoo plugin a memory injection?"

[1] messages.transform
  → query: "jak funguje doobidoo plugin..."
  → log: [MEMORY] search done: total=8 (id=3 les=2 ctx=3 rec=0)

[2] system.transform
  → system parts: 1 → 2
  → toast: "Memory: 8 injected (3id 2les 3ctx 0rec)"
  → memory block preview (first 400 chars):
      ## Workspace Memory
      <memory-context>
      ...

══ RESULT ════════════════════════════════════
  ✓ inject OK   stored: 0
══════════════════════════════════════════════
```

---

## Message Fixture Structure

For harness and future tests, messages must match OpenCode's internal format:

```ts
// User message
{
  info: { role: "user", sessionID: "test-session-123" },
  parts: [{ type: "text", text: "user prompt here", synthetic: false }]
}

// Assistant message
{
  info: { role: "assistant", sessionID: "test-session-123" },
  parts: [{ type: "text", text: "assistant response here" }]
}

// Synthetic part (injected by beads/other plugins — ignored by memory plugin)
{
  info: { role: "user", sessionID: "test-session-123" },
  parts: [{ type: "text", text: "injected content", synthetic: true }]
}
```

---

## Common Gotchas

- **`allMessages` before declaration** — always fetch messages (`await client.session.messages(...)`) before accessing `allMessages` anywhere in the `session.idle` handler. Using `allMessages` before its `await` causes a reference-before-declaration bug.
- **`MIN_CHAT_SYSTEM_CHARS = 10_000`** — system.transform skips system prompts shorter than 10 000 chars. In harness, use `"x".repeat(10_001)` as base system content or a realistic system prompt.
- **Synthetic parts** — beads plugin injects synthetic user messages at the end of messages array. Always search backwards for non-synthetic user text when extracting the query.
- **Double-search guard** — `lastInjectedQuery` prevents re-searching the same prompt. In harness, reset state between scenarios (reinitialize plugin).
- **node_modules/@opencode-ai/plugin not installed** — `import type { Plugin }` is type-only, stripped by Bun at runtime. The harness can import `src/plugin.ts` directly without the package present in node_modules.

---

## Commit Convention

Follow Conventional Commits:
- `feat:` — new functionality
- `fix:` — bug fix
- `refactor:` — code restructure without behavior change
- `test:` — harness / tests
- `docs:` — documentation only
- `chore:` — tooling, deps, config

---

## Session Close Checklist

```
[ ] bun run typecheck        — no type errors
[ ] bun run harness          — all scenarios pass
[ ] git add + git commit
[ ] git push
```
