# opencode-doobidoo-plugin

OpenCode plugin for [doobidoo/mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) — semantic memory injection and session summarization.

## What it does

- **Injects relevant memories** into every LLM call (identity, lessons learned, semantic context)
- **Skips memory inject for subagents** — sessions with `parentID` (spawned via Task tool) don't get memories injected (they have explicit instructions)
- **Saves session summaries** automatically on session end — both code sessions (files changed) and conversation sessions (research, planning)
- **Extracts lessons** from compaction summaries and stores them as discrete memory entries
- **Pre-warms** the memory server on session start

## Requirements

- [doobidoo/mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) running locally (HTTP mode)
- OpenCode with Bun runtime
- `@opencode-ai/plugin` SDK

## Installation

### Option A — Development (symlink, recommended)

```bash
git clone https://github.com/mapix-etnc/opencode-doobidoo-plugin ~/Projects/opencode-doobidoo-plugin

# Symlink into OpenCode plugins directory (auto-loaded by OpenCode)
ln -sf ~/Projects/opencode-doobidoo-plugin/src/plugin.ts \
        ~/.config/opencode/plugins/memory-hooks.ts
```

OpenCode auto-loads all `.ts` files from `~/.config/opencode/plugins/`. No build step needed — edit `src/plugin.ts` and OpenCode picks up changes immediately.

### Option B — npm package

```bash
# In your OpenCode plugins directory
npm install opencode-doobidoo-plugin
```

Add to `~/.config/opencode/opencode.json`:
```json
{
  "plugin": ["opencode-doobidoo-plugin"]
}
```

## Configuration

All configuration is via environment variables. Set in the startup script for `mcp-memory-service`, or export before starting OpenCode.

| Variable | Default | Description |
|---|---|---|
| `DOOBIDOO_API_URL` | `http://localhost:8000/api` | Base URL of the doobidoo REST API |
| `MEMORY_API_KEY` | reads from `~/.config/opencode/secrets/memory-api-key` | Bearer token for write operations |
| `MEMORY_MIN_SCORE` | `0.55` | Minimum similarity score for semantic retrieval |
| `MEMORY_INJECT_LIMIT` | `7` | Maximum number of semantic memories to inject per call |

## Memory types saved

| Type | Tag | Condition |
|---|---|---|
| `session_summary` | `files-changed` | Session with file edits |
| `conversation_summary` | `conversation` | Conversation-only session (assistant text > 300 chars) |
| `lessons-learned` | `compaction-extracted` | Extracted from compaction summary `## LESSONS LEARNED` sections |

## Development workflow

```
1. Edit src/plugin.ts
2. bun tsc --noEmit          # optional type check
3. OpenCode picks up changes automatically (symlink)
4. git commit + push
```

Install dev dependencies for type checking:

```bash
cd ~/Projects/opencode-doobidoo-plugin
bun install
bun run typecheck
```

## Architecture

```
OpenCode session
    │
    ├── messages.transform  → search memories → pendingMemoryBlock
    ├── system.transform    → check parentID → inject pendingMemoryBlock into system prompt
    ├── tool.execute.after  → track tool calls + changed files
    ├── session.idle        → save session/conversation summary
    └── session.compacting  → extend compaction prompt → extract lessons on next idle
```

The two-phase inject (messages.transform → system.transform) guarantees that memory context is appended to the system prompt *after* all other content is assembled but *before* the LLM call.

Subagent detection: `system.transform` checks `session.parentID` (via `client.session.get()`). If present, the session is a subagent — inject is skipped (subagents have explicit instructions and don't need memories).

## License

MIT
