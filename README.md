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

## Service Configuration

mcp-memory-service must be configured for MS-MARCO single-model quality scoring.
Add the following to the startup wrapper script (e.g. `~/.local/bin/memory-server-start`):

```bash
# Quality scoring — MS-MARCO only (no DeBERTa)
# DeBERTa is optimised for web/academic text; it scores short agent snippets
# at 0.03–0.10 which is uninformative. MS-MARCO is a cross-encoder trained
# on query-document relevance and rescores correctly on every retrieve call.
export MCP_QUALITY_SYSTEM_ENABLED=true
export MCP_QUALITY_AI_PROVIDER=local
export MCP_QUALITY_LOCAL_MODEL="ms-marco-MiniLM-L-6-v2"
export MCP_QUALITY_LOCAL_DEVICE=auto
export MCP_QUALITY_FALLBACK_ENABLED=false   # single model, no DeBERTa fallback
export MCP_QUALITY_BOOST_ENABLED=true       # rescore on every retrieve with real query

# Memory cleanup / retention (consolidation pipeline)
# All schedules are disabled by default — enable only if you want automatic
# forgetting and consolidation. quality_score affects retention tier:
#   >= 0.7 → high  (MCP_QUALITY_RETENTION_HIGH,  default 365 days)
#   >= 0.5 → medium (MCP_QUALITY_RETENTION_MEDIUM, default 180 days)
#   <  0.5 → low   (MCP_QUALITY_RETENTION_LOW_MIN–MAX, default 30–90 days)
# Deletion only happens for low-quality + potential duplicate memories.
export MCP_CONSOLIDATION_ENABLED=true
export MCP_FORGETTING_ENABLED=false            # keep all memories by default
export MCP_RETENTION_CRITICAL=730             # 2 years for long-term memories
export MCP_RETENTION_EPHEMERAL=7              # 1 week for session summaries
export MCP_ASSOCIATION_MIN_SIMILARITY=0.4     # association graph precision
export MCP_COMPRESSION_THRESHOLD=0.8         # compress only low-relevance memories
export MCP_CONSOLIDATION_QUALITY_BOOST_ENABLED=true
export MCP_CONSOLIDATION_MIN_CONNECTIONS_FOR_BOOST=5
export MCP_CONSOLIDATION_QUALITY_BOOST_FACTOR=1.2
```

> **Note on store-time scoring:** MS-MARCO receives `query=""` at store time (hard-coded
> in the library), which returns `0.0`. This is expected — retrieval is driven by embedding
> distance (not quality_score), and the BOOST mechanism rescores every retrieved memory with
> the real query. After the first retrieve the score is correct. See
> `Analysis/model-selection-deberta-vs-msmarco.md` for full reasoning.

> **After changing model configuration:** run `scripts/rescore.py` to update quality scores
> for all existing memories using historical access queries as context.

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
