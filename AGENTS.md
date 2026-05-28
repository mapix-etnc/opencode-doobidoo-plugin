# AGENTS.md — opencode-doobidoo-plugin

> Full guide: `.config/opencode/AGENTS.md` — read it before making non-trivial changes.

## Project

An OpenCode plugin that automatically injects relevant memories from the doobidoo HTTP server
into the LLM system prompt, and saves session summaries back to memory after each session.

## Runtime & toolchain

- **Bun only** (`engines.bun >=1.0`). No npm, no build step.
- Plugin entry: `src/plugin.ts` — single file, loaded directly by OpenCode via symlink.
- `tsconfig.json` includes only `src/**/*.ts` — `scripts/*.ts` are **not** typechecked by `bun run typecheck`.

## Development setup

- **OpenCode source code**: symlink `opencode-src` → `../opencode-src` (gitignored).
  - Enables IDE navigation into `@opencode-ai/plugin` and `@opencode-ai/sdk` source.
  - Path mappings in `tsconfig.json` resolve `@opencode-ai/*` to `../opencode-src/packages/*/src/index.ts`.
  - Only `packages/plugin/src/**/*.ts` and `packages/sdk/js/src/**/*.ts` are included in typecheck.
  - Run `bun run typecheck` after modifying `tsconfig.json` to verify paths work.

## File Map

```
src/plugin.ts                    ← entire plugin (~600 lines), single entry point
scripts/harness.ts               ← local test harness (no live LLM)
scripts/e2e.ts                   ← E2E test (real OpenCode + real LLM)
scripts/e2e-subagent.ts          ← E2E test for subagent inject skip
scripts/rescore.py               ← batch MS-MARCO rescore utility
Specs/                           ← reference documentation (committed, permanent)
docs/adr/                        ← architectural decision records (committed, permanent)
```

## Architecture: Two-Phase Inject

The inject pipeline runs in two hooks in guaranteed order:

```
1. experimental.chat.messages.transform
   └→ extract user prompt text from messages (filter !p.synthetic)
   └→ search doobidoo: identity/preference tags + semantic + lessons + recent fallback
   └→ build memory block text
   └→ store in sessionState[sessionId].pendingMemoryBlock
   └→ update lastInjectedQuery (double-search guard)

2. experimental.chat.system.transform
   └→ check guards (see below)
   └→ read pendingMemoryBlock from state
   └→ output.system.push(pendingMemoryBlock.text)    ← appended LAST (preserves prompt cache)
   └→ clear pendingMemoryBlock
```

**Why two phases?** `messages.transform` has access to message content; `system.transform`
has access to `output.system`. Both are needed; the ordering is guaranteed by OpenCode.
See `docs/adr/0001-two-phase-inject.md`.

### All Registered Hooks

| Hook | Purpose |
|------|---------|
| `event` (generic) | `session.created` → pre-warm doobidoo; `session.idle` → save summary / extract lessons |
| `tool.execute.after` | Track tool call names + changed files (write/edit tools) |
| `experimental.chat.messages.transform` | Memory search → pendingMemoryBlock |
| `experimental.chat.system.transform` | Inject pendingMemoryBlock into system prompt |
| `experimental.session.compacting` | Set pendingLessonsExtraction flag + extend compaction prompt |

### Session State

`sessionState: Map<sessionID, SessionState>` — per-session tracking, deleted after `session.idle`.

```typescript
{
  lastInjectedQuery: string          // double-search guard (skip if query unchanged)
  toolCalls: string[]                // tool names used (for session summary + session gate)
  changedFiles: Set<string>          // files written/edited (determines isCodeSession)
  lastUserMessageText: string        // last non-synthetic user prompt (for session summary)
  pendingLessonsExtraction: boolean  // true after compaction, until idle
  pendingMemoryBlock: {              // populated in messages.transform, consumed in system.transform
    text: string
    totalCount: number
    counts: { identity: number; lessons: number; context: number; recent: number }
  } | null
}
```

### Guard Conditions in system.transform

`system.transform` skips inject when ANY of these is true:

1. **Subagent**: `session.parentID` is set → skip entirely (see `docs/adr/0002-subagent-skip.md`)
2. **Post-compaction**: `state.pendingLessonsExtraction === true` → skip to avoid double compaction (see `docs/adr/0003-post-compaction-guard.md`)
3. **Internal LLM call**: `system.join("").length < 10_000` → skip title generation etc. (see `docs/adr/0005-10000-char-threshold.md`)
4. **No pending block**: `state.pendingMemoryBlock === null` → nothing to inject

### Memory Inject Composition

Four channels, deduplicated by `content_hash`:

```
1. Identity/Preferences  — searchMemoriesByTag(["identity","preference"], limit=8)
                           → always injected, no score filter
2. Lessons Learned       — searchMemoriesByTag(["lessons-learned"], limit=5)
                           → always injected, deduplicated against channel 1
3. Semantic Context      — searchMemories(userPrompt, limit=7, threshold=0.55)
                           → session summaries filtered out
4. Recent Sessions       — getRecentSessionMemories(limit=5)
                           → only if semantic returned < 2 results (fallback)
```

Max theoretical: ~25 memories. In practice: 8–15 after dedup.

### session.idle: Two Code Paths

**Path A — Post-compaction** (`pendingLessonsExtraction === true`):
- Scan messages for `## LESSONS LEARNED` section
- Extract bullet points → store each as `lessons-learned` + `compaction-extracted` memory
- Reset flag, delete session state, return early

**Path B — Normal session end**:
- Gate: `toolCalls.length < SESSION_MIN_TOOLS (2)` → skip (too short)
- Gate: `!isCodeSession && assistantText < CONVERSATION_MIN_CHARS (300)` → skip (trivial conversation)
- Build summary: date, workDir, firstUserText, toolSummary, changedFiles, last 3 assistant texts
- `isCodeSession = changedFiles.size > 0`
- Tags: `["session", date, ...]` + optional `files-changed`, `conversation`, `bash`, `lessons-learned`
- `memoryType`: `session_summary` (code) or `conversation_summary` (chat)

### Compaction Hook

`experimental.session.compacting`:
1. Sets `state.pendingLessonsExtraction = true`
2. Appends to `output.context` — instructions for the compaction LLM:
   - Write a `## LESSONS LEARNED` section at the end of the summary
   - **CRITICAL**: do NOT call any tools during compaction (unavailable)
   - Format: `"Expected X, found Y → next time do Z"`
3. Plugin automatically extracts lessons on next `session.idle`

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `DOOBIDOO_API_URL` | `http://localhost:8000/api` | Base URL of doobidoo REST API |
| `MEMORY_API_KEY` | reads from `~/.config/opencode/secrets/memory-api-key` | Bearer token for write ops |
| `MEMORY_MIN_SCORE` | `0.55` | Minimum similarity score |
| `MEMORY_INJECT_LIMIT` | `7` | Max semantic memories per inject |

## Plugin Loading

Plugin is loaded by OpenCode via symlink:

```
~/.config/opencode/plugins/opencode-doobidoo-plugin.ts
  → /var/home/mpx/Projects/opencode-doobidoo-plugin/src/plugin.ts
```

**CRITICAL GOTCHA**: Plugin is cached in memory. Code changes have NO effect until OpenCode
is fully restarted.

## Key commands

```bash
bun install                        # install deps
bun run typecheck                  # tsc --noEmit, ~2s
bun run harness                    # run all harness scenarios (live doobidoo required)
bun run harness inject             # single scenario: inject | guard | session | conversation | short
bun run harness --dry-run          # no writes to doobidoo
bun run e2e                        # full E2E via real OpenCode subprocess (~30s, .env required)
bun run e2e-subagent               # verify subagent sessions do NOT get injected (~30s, .env required)
```

No lint, no format, no build scripts defined.

## Testing matrix

| Level | Command | Catches |
|-------|---------|---------|
| Typecheck | `bun run typecheck` | Type errors in `src/` only |
| Harness | `bun run harness` | Inject pipeline, session saving logic |
| E2E | `bun run e2e` | Hook registration, plugin loading, real LLM inject |
| E2E subagent | `bun run e2e-subagent` | Verifies subagent sessions are NOT injected |

Run E2E after upgrading `@opencode-ai/plugin` or `@opencode-ai/sdk` — silent hook renames are the primary failure mode.

**Harness constraint**: fake system prompt must be ≥ 10,001 chars (matches the 10,000-char
internal LLM skip threshold in `system.transform`).

**E2E prerequisites**: `.env` with `DOOBIDOO_API_URL`, `MEMORY_API_KEY`, `E2E_MODEL`.
LLM credentials from `~/.local/share/opencode/auth.json`.

## Gotchas

- **Plugin cached in memory** — file changes have no effect until OpenCode is restarted.
- **Synthetic parts** — beads plugin injects synthetic user messages; always filter `!p.synthetic` when extracting query.
- **`allMessages` before declaration** — in `session.idle` handler, always `await client.session.messages(...)` before using `allMessages`.
- **`@opencode-ai/plugin` import is type-only** — stripped by Bun at runtime; harness works without the package in node_modules.
- **`bun.lock` in `.gitignore`** — exists in working tree but is gitignored; don't commit it.
- **`temp/` adresář** — dočasné soubory (výstupy z bash příkazů pro nativní nástroje) patří sem, ne do `/tmp`. Adresář je v `.gitignore`.
- **doobidoo memory server je vždy dostupný** — při vývoji a testech (harness + e2e) předpokládejte běžící server na localhost:8000.
- **10,000-char threshold** — `system.transform` skips if `system.join("").length < 10_000`. Harness fake system prompt must be ≥ 10,001 chars. See `docs/adr/0005-10000-char-threshold.md`.
- **Double-search guard** — `lastInjectedQuery === msgText` → skip. Prevents redundant searches when user resends same prompt.
- **Post-compaction guard** — memory inject skipped when `pendingLessonsExtraction === true`. Without this, inject after compaction can push context over limit → second compaction loop. See `docs/adr/0003-post-compaction-guard.md`.

## Reference Documentation

Committed permanent docs — read for design context before planning changes:

| File | What it covers |
|------|---------------|
| `Specs/memory-service-integration.md` | Full API integration: endpoints, request/response, two-phase inject rationale |
| `Specs/memory-data-structure.md` | Memory JSON schema, tag heuristics, quality scoring |
| `Specs/embedding-and-semantic-search.md` | How all-MiniLM-L6-v2 works, similarity scoring, inject composition |
| `Specs/memory-gaps-future-potential.md` | 6 identified gaps — **read before planning new features** |
| `Specs/memory-knowledge-opportunity-analysis.md` | Knowledge base expansion opportunities, workspace tagging proposal |
| `Specs/models-inventory.md` | Model descriptions (all-MiniLM, MS-MARCO, DeBERTa) |
| `Specs/no-inject-for-subagents.md` | Rationale for subagent session skip |
| `docs/adr/` | Architectural Decision Records (MADR format) — 6 decisions documented |

## Agentic Workflow

Full protocol: `AGENTIC_WORKFLOW.md` — read it for complete command reference and interactive flow details.

### Core Principles (ACE-FCA)

> "A bad line of research could land you with thousands of bad lines of code."

- **Human as Orchestrator** — you drive; agents execute
- **Frequent Intentional Compaction** — each phase runs in fresh context (subtask); use `/handoff` before context limit
- **Artifacts over Memory** — persist working state to `.beads/artifacts/` (spec, research, plan); artifacts are ephemeral, never committed
- **Research → Plan → Implement** — mandatory sequence; never skip phases
- **High-Leverage Review** — `/research` and `/plan` are always interactive dialogues, not passive artifact reviews

### Dialectical Autocoding (Coach-Player)

- **Player** implements; **Coach** validates independently against `spec.md`
- Max 10 implementation turns per phase — escalate to human if coach does not approve

### Workflow Commands

```
/create       → interview → bead + spec.md
/start        → bd ready → setup workspace → exploration-context.md
/research     → INTERACTIVE: explore → present → iterate → research.md
/plan         → INTERACTIVE: generate → walk through → iterate until approved → plan.md
/implement    → execute plan with /coach checkpoints (max 10 turns/phase)
/finish       → coach review → commit + close bead
/handoff      → capture state before context limit
/rehydrate    → resume from latest handoff
```

### Requirements & Specifications (EARS)

When defining **any** requirements document (`spec.md`, feature spec, API contract):

**MUST** use the EARS skill before finalizing:

```
skill("ears-requirements-validator")
```

EARS (Easy Approach to Requirements Syntax) validates that requirements are unambiguous, testable, and complete. Use it especially during `/create` (spec.md definition) and `/plan` (success criteria per phase).

## Session close checklist

```
[ ] bun run typecheck
[ ] bun run harness (všechny scenáře)
[ ] bun run e2e (až po úspěšném harness)
[ ] git add + git commit (conventional commits: feat/fix/refactor/test/docs/chore)
[ ] git push
```

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
