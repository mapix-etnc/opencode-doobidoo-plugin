# AGENTS.md — opencode-doobidoo-plugin

> Full guide: `.config/opencode/AGENTS.md` — read it before making non-trivial changes.

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

## Key commands

```bash
bun install                        # install deps
bun run typecheck                  # tsc --noEmit, ~2s
bun run harness                    # run all harness scenarios (live doobidoo required)
bun run harness inject             # single scenario: inject | guard | session | conversation | short
bun run harness --dry-run          # no writes to doobidoo
bun run e2e                        # full E2E via real OpenCode subprocess (~30s, .env required)
```

No lint, no format, no build scripts defined.

## Testing matrix

| Level | Command | Catches |
|-------|---------|---------|
| Typecheck | `bun run typecheck` | Type errors in `src/` only |
| Harness | `bun run harness` | Inject pipeline, session saving logic |
| E2E | `bun run e2e` | Hook registration, plugin loading, real LLM inject |

Run E2E after upgrading `@opencode-ai/plugin` or `@opencode-ai/sdk` — silent hook renames are the primary failure mode.

## Architecture: two-phase inject (design contract)

1. `messages.transform` → search doobidoo, store result in `sessionState.pendingMemoryBlock`
2. `system.transform` → append block to `output.system[]`, clear state

`system.transform` skips calls where `system.join("").length < 10_000` (internal LLM calls like title generation). Harness fake system prompt must be ≥ 10 001 chars.

## Session state

`sessionState: Map<sessionID, {...}>` tracks per-session: tool calls, changed files, last user message, pending memory block, last injected query (double-search guard), pending lessons flag.

## E2E prerequisites (.env)

```env
DOOBIDOO_API_URL=http://localhost:8000/api
MEMORY_API_KEY=<token>
E2E_MODEL=llm-test/qwen3-8b
```

LLM credentials read from `~/.local/share/opencode/auth.json` automatically.

## Gotchas

- **Plugin cached in memory** — file changes have no effect until OpenCode is restarted.
- **Synthetic parts** — beads plugin injects synthetic user messages; always filter `!p.synthetic` when extracting query.
- **`allMessages` before declaration** — in `session.idle` handler, always `await client.session.messages(...)` before using `allMessages`.
- **`@opencode-ai/plugin` import is type-only** — stripped by Bun at runtime; harness works without the package in node_modules.
- **`bun.lock` in `.gitignore`** — exists in working tree but is gitignored; don't commit it.
- **`temp/` adresář** — dočasné soubory (výstupy z bash příkazů pro nativní nástroje) patří sem, ne do `/tmp`. Adresář je v `.gitignore`.
- **doobidoo memory server je vždy dostupný** — při vývoji a testech (harness + e2e) předpokládejte běžící server na localhost:8000.

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
