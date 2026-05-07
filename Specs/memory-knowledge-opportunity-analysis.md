# Analýza příležitostí pro rozšíření memory — znalostní základna agenta

**Datum:** 2026-05-07  
**Kontext:** Komplexní analýza toho, co je aktuálně mimo memory a jak by přesun do memory s čistým schématem zlepšil kvalitu agenta. Zahrnuje průchod 72 changelogů, 10 rules souborů, agents/gws.md a AGENTS.md.

---

## Klíčový princip

```
Statický system prompt  →  VŽDY v kontextu, cache-friendly, garantované chování
                           Patří sem: behavioral rules, bezpečnostní guardraily,
                           jazyková pravidla, formátovací konvence

Memory inject           →  Dynamický, relevance-based, úspora tokenů
                           Patří sem: factual knowledge, procedures, gotchas,
                           lessons learned, environment facts
```

**Anti-pattern:** přesouvat bezpečnostně kritická pravidla ze static promptu do memory. Memory inject je pravděpodobnostní (score >= 0.55) — garantovaná pravidla musí zůstat ve static promptu a těžit z prompt cache.

---

## Navrhované tag schema

### Současný stav — problém

Aktuální tagy jsou ploché a ad-hoc: `opencode`, `git`, `gitlab`, `memory-hooks`, `plugin`, `gws`... Desítky tagů s count 1–2, žádná konzistentní hierarchie, duplicity (`preference` vs `user-preference`).

### Navrhované namespaced schéma

Formát: `namespace:value`

```
source:plugin        — uloženo automaticky pluginem
source:agent         — uloženo vědomě agentem přes MCP
source:user          — uloženo na explicitní požadavek uživatele
source:import        — importováno z changelogs / hromadný import

type:preference      — trvalá preference uživatele
type:identity        — identita uživatele (jméno, role, účty)
type:environment     — fakta o prostředí (OS, cesty, účty, verze)
type:procedure       — jak něco udělat (workflow, postup)
type:gotcha          — known pitfall, co nefunguje a proč
type:lesson          — naučená lekce (Expected X, found Y → do Z)
type:summary         — souhrn session/compaction

domain:memory        — doobidoo, mcp-memory-service, plugin
domain:gws           — Google Workspace, gws CLI, gdocs
domain:git           — git, GitHub, GitLab
domain:opencode      — OpenCode konfigurace, agenti, pluginy
domain:beads         — beads task tracker, bd CLI
domain:system        — OS, toolbox, systemd, podman
domain:atlassian     — Jira, Confluence, acli
domain:tools         — ostatní nástroje (LSP, CLI utilities)

scope:always         — vždy injektovat (nahrazuje identity/preference priority kanál)
scope:on-demand      — injektovat jen při sémantické shodě (default)
```

### Příklad použití

```
Místo:  tags: ["preference", "git", "gitlab", "session"]
Nově:   tags: ["source:agent", "type:preference", "domain:git", "scope:always"]

Místo:  tags: ["lessons-learned", "compaction-extracted", "2026-05-05"]
Nově:   tags: ["source:plugin", "type:lesson", "domain:memory", "scope:on-demand", "2026-05-05"]
```

---

## Navrhované memory_type schema

Aktuálně vše ukládáno jako `"observation"` — nediferencuje zdroj ani účel.

| memory_type | Popis | Kdy použít |
|---|---|---|
| `preference` | Trvalá preference uživatele | Uživatel vyjádří preference |
| `identity` | Identita uživatele a prostředí | Fakta o uživateli, účtech, prostředí |
| `procedure` | Jak provést specifický úkol | Workflow, příkazy, postupy |
| `gotcha` | Známá past — co nefunguje a proč | Neočekávané chování, limity nástrojů |
| `lesson` | Naučená lekce (Expected → Found → Fix) | Postmortems, řešení incidentů |
| `environment` | Fakta o instalaci a konfiguraci | Cesty, verze, config locations |
| `session_summary` | Souhrn proběhlé session | Plugin (session.idle) |
| `conversation_summary` | Souhrn konverzační session | Plugin (session.idle, isCodeSession=false) |

---

## Příležitosti — co přesunout do memory

### 1. changelogs/ (72 souborů) — NEJVYŠŠÍ HODNOTA

**Aktuální stav:** Agent musí changelogy hledat manuálně (pravidlo v AGENTS.md + rules/memory-usage.md). Relevantní gotchas a lessons se dostávají do kontextu jen pokud agent aktivně hledá správná klíčová slova.

**Příležitost:** Klíčové lessons/gotchas z changelogů v memory → plugin je injektuje automaticky na základě sémantické relevance dotazu.

**Odhad obsahu:** ~54/72 souborů obsahuje reusable knowledge. Přibližně 80–120 konkrétních memory entries.

#### Kategorie podle domény

**domain:memory (~15 entries)**
- MCP stdio vs HTTP API rozdíl; write operace vyžaduje Bearer token i při anon read
- Port conflict → wrapper musí zabít port před startem service
- `kill -9` na Python uvnitř toolbox → nekonzistentní crun stav; použít `podman stop && podman start`
- EN-only embedding degraduje CZ data → nutný multilingual model
- Compaction hook: MCP tools nejsou dostupné → vše musí být plain text v `## LESSONS LEARNED`
- `MCP_QUALITY_BOOST_ENABLED` nezapíná sám `SYSTEM_ENABLED`; obě env vars nutné explicitně

**domain:gws (~8 entries)**
- `supportsAllDrives=true` nutné pro všechny Shared Drive operace; 404 ≠ access denied
- `google-workspace-mcp` vrací „no structuredContent" i když operace proběhla → validovat business výsledek, ne jen MCP response
- Multi-account gws: wrapper funkce/binárky spolehlivější než bash aliasy
- gws config dirs: `/var/home/mpx/.config/gws-work/`, `/var/home/mpx/.config/gws-personal/`

**domain:opencode (~14 entries)**
- Plugin override: agent config v pluginu přebíjí opencode.json přebíjí lokální markdown agent
- Patch lifecycle: každý patch musí mít re-apply skript; bez něj se fix ztratí při update
- Binary patching je nouzové; bezpečný vzor je source build + atomický deploy + rollback
- Config cesta: `/var/home/mpx/.config/opencode/opencode.json` (ne `~/.opencode/config.json`)

**domain:system (~9 entries)**
- Fedora Silverblue: host vs toolbox boundary pro env propagaci a sudo
- `host-spawn sudo` nefunguje (no tty); správně `host-spawn pkexec`
- systemd user services: `~/.config/systemd/user/`, aktivace `systemctl --user enable`
- Power management: udev + systemd pro event-driven profile switch

---

### 2. agents/gws.md — gotchas a procedures mimo hlavní kontext

**Aktuální stav:** Obsah `gws.md` dostane jen @gws subagent, nikdy hlavní agent. Hlavní agent neví o gotchas a procedurah GWS, pokud se jich nezeptá explicitně.

**Příležitost:** Klíčové gotchas a procedures z gws.md v memory → hlavní agent je dostane injektované při relevantním dotazu.

**Konkrétní kandidáti (type:gotcha, domain:gws):**

```
"GWS Shared Drive: soubory vrátí 404 bez supportsAllDrives=true — i při existujícím přístupu.
 Vždy přidat --params '{\"supportsAllDrives\":\"true\"}' pro files.get a files.list."

"GWS gws docs +write: text začínající '--' nebo '---' je interpretován jako CLI flag → selhání.
 Řešení: přidat mezeru před text, nebo použít gdocs-cli (Workflow C)."

"GWS brand-guidelines skill v Docs kontextu: instrukce jsou ve formátu python-pptx,
 nekompatibilní s Google Docs API → doom loop → abort session. Nepoužívat pro Google Docs."

"GWS velké soubory: -o přesměruje output do souboru; piping po -o nemá efekt.
 Pro velké soubory: drive files export → stáhnout do ~/OpenCode/temp/, pak zpracovat."
```

**Konkrétní kandidáti (type:procedure, domain:gws):**

```
"GWS MIME type check: před jakoukoliv operací s dokumentem vždy ověřit mimeType přes
 drive files get --params '{\"fileId\":\"ID\",\"supportsAllDrives\":\"true\",\"fields\":\"name,mimeType\"}'.
 google-apps.document → gdocs-cli; .docx → docx skill; nový z MD → md2docx-pipeline."

"GWS účty: gws-work (martin.pohl@etnetera.cz, default), gws-personal (martin.pohl.cz@gmail.com).
 Skills používají bare 'gws' → vždy nahradit za gws-work nebo gws-personal."
```

---

### 3. rules/ — pouze environment-specific fakta

**Aktuální stav:** Všechna rules jsou správně ve statickém system promptu. Analýza ukázala, že ~85 % jsou behavioral rules (A) — patří do static promptu, ne do memory.

**Příležitost:** Malá podmnožina environment-specific faktů (typ B) by jako memory entries usnadnila aktualizaci bez změny rules souborů.

| Fakt | type | domain | scope |
|---|---|---|---|
| `glab` authenticated pro `git.etnetera.cz`, user `mapix` | environment | git | always |
| `gh` je authenticated | environment | git | always |
| Changelog search path: `~/OpenCode/changelogs` | environment | opencode | always |
| Temp path pattern: `~/OpenCode/temp/oc_*.txt` | environment | opencode | on-demand |
| gws config dirs: `~/.config/gws-work/`, `~/.config/gws-personal/` | environment | gws | on-demand |

**Poznámka:** Tato fakta jsou nyní v rules souborech a je to správné — jsou malá a nemění se. Do memory by měla smysl přidat jen pokud by se pravidla vyčistila od faktů (separace concerns).

---

### 4. AGENTS.md — identity a environment fakta

**Aktuální stav:** AGENTS.md je celý v system promptu. Obsahuje mix behavioral rules + environment facts.

**Příležitost:** Environment-specific fakta vhodná jako `type:identity` + `scope:always`:

```
"Prostředí: Fedora Silverblue 43 (immutable host OS), toolbox 'code' (hlavní dev environment).
 Package managers: DNF (toolbox), Flatpak (host), Podman (host)."

"Workspace model: ~/OpenCode = central hub repo, ~/Projects/ = externí projekty.
 OpenCode běží v hubu, ostatní projekty přes absolutní cesty."

"Instalační priorita: 1. DNF, 2. Flatpak, 3. Podman, 4. rpm-ostree (jen se souhlasem, vyžaduje reboot)."
```

---

## Co ZŮSTÁVÁ ve statickém system promptu

Tato pravidla nesmí přejít do memory — musí být garantována bez ohledu na relevanci dotazu:

- Jazyková pravidla (Czech only, English pro rules/code)
- Bezpečnostní guardraily (rm -rf, secrets, email send)
- Routing pravidla (bash zakázaný, explore/executor routing)
- Komunikační styl (no emoji, concise)
- Memory search pravidla (nepoužívat memory_search manuálně na session startu)
- Authorization guardraily (MR/PR bez souhlasu, state-changing ops potvrdit)

---

## Implementační priority

### P1 — Okamžitá hodnota (nízká komplexnost)

1. **Inicializovat `scope:always` identity memories** — fakta o uživateli, prostředí, účtech. Plugin má kanál pro `identity` tag, ale je prázdný (0 záznamů).
2. **Importovat top-20 gotchas z changelogů** — domain:memory, domain:gws, domain:opencode. Tyto se opakují a agent je musí aktuálně hledat manuálně.
3. **Přidat GWS gotchas do memory** — 5–6 konkrétních entries z gws.md, dostupné hlavnímu agentovi.

### P2 — Střední hodnota (střední komplexnost)

4. **Normalizovat existující tagy** — přejít na namespace schéma pro nové entries. Starší entries ponechat (retag je riziková operace).
5. **Opravit memory_type v pluginu** — session_summary a conversation_summary ukládat se správným typem, ne `observation`.
6. **Přidat procedury jako on-demand memory** — gws workflow, beads workflow, git workflow pro méně časté operace.

### P3 — Vyšší hodnota (vyšší komplexnost)

7. **Hromadný import z changelogů** — strukturovaný skript který projde changelogy a extrahuje lessons/gotchas jako memory entries s namespaced tagy.
8. **Plugin rozšíření** — ukládat nové entries s namespaced tagy místo ad-hoc tagů.
9. **`scope:always` implementace v pluginu** — přidat `scope:always` do priority tag seznamu vedle `identity` a `preference`.

---

## Příklady ideálních memory entries

### identity (scope:always)
```json
{
  "content": "Uživatel: Martin Pohl, pracovní email martin.pohl@etnetera.cz, osobní martin.pohl.cz@gmail.com. GitLab user: mapix (git.etnetera.cz). GitHub: mapix-etnc.",
  "tags": ["source:agent", "type:identity", "scope:always"],
  "memory_type": "identity"
}
```

### environment (scope:always)
```json
{
  "content": "Prostředí: Fedora Silverblue 43 (host, immutable), toolbox 'code' (dev). ~/OpenCode = central hub repo. ~/Projects/ = externí projekty. Package install pořadí: DNF > Flatpak > Podman > rpm-ostree.",
  "tags": ["source:agent", "type:environment", "domain:system", "scope:always"],
  "memory_type": "environment"
}
```

### gotcha (scope:on-demand)
```json
{
  "content": "GWS Shared Drive: soubory vrátí HTTP 404 bez supportsAllDrives=true i při platném přístupu. Vždy přidat --params '{\"supportsAllDrives\":\"true\"}' pro files.get a files.list. 404 ≠ access denied.",
  "tags": ["source:import", "type:gotcha", "domain:gws", "scope:on-demand"],
  "memory_type": "gotcha"
}
```

### lesson (scope:on-demand)
```json
{
  "content": "mcp-memory-http: kill -9 na Python procesu uvnitř toolbox container zanechá crun v nekonzistentním stavu — podman hlásí 'Up', ale service nereaguje. Fix: podman stop + podman start (ne jen podman start).",
  "tags": ["source:import", "type:lesson", "domain:memory", "domain:system", "scope:on-demand", "2026-03-21"],
  "memory_type": "lesson"
}
```

### procedure (scope:on-demand)
```json
{
  "content": "GWS operace: před každou operací s dokumentem ověřit mimeType: gws-work drive files get --params '{\"fileId\":\"ID\",\"supportsAllDrives\":\"true\",\"fields\":\"name,mimeType\"}'. google-apps.document → gdocs-cli; .docx → docx skill; nový z MD → md2docx-pipeline.",
  "tags": ["source:import", "type:procedure", "domain:gws", "scope:on-demand"],
  "memory_type": "procedure"
}
```

---

## Workspace-scoped memory

### Problém

Uživatel pracuje ve více workspace současně:
- `~/OpenCode` — obecná práce, centrální hub
- `~/Projects/opencode-doobidoo-plugin` — vývoj pluginu
- `~/Projects/agent-toolbox` — atd.

Doobidoo má **jednu sdílenou DB** pro všechny workspace. Aktuálně plugin ukládá `workDir` do textu session summary, ale nepoužívá ho ani jako tag při ukládání, ani jako hint při vyhledávání.

### Global vs. workspace-scoped

```
GLOBAL (sdílené napříč všemi workspace):
  type:identity      — kdo jsi, účty, prostředí
  type:environment   — OS, toolbox, paths, tools
  type:gotcha        — git, gws, systemd, CLI tools
  type:preference    — jak pracuješ, communication style
  type:lesson        — obecné lessons (Expected X → Y → do Z)

WORKSPACE-SCOPED (relevantní pro konkrétní projekt):
  type:procedure     — workflow specifický pro projekt
  type:lesson        — lessons specifické pro kód projektu
  type:summary       — session summaries (vždy z konkrétního workspace)
```

### Navrhovaná dimension `workspace:` v tag schématu

Přidat `workspace:` jako novou dimenzi vedle `source:`, `type:`, `domain:`, `scope:`:

```
workspace:global                      — sdílené napříč vším (default pro identity/gotcha/preference)
workspace:opencode                    — ~/OpenCode
workspace:opencode-doobidoo-plugin    — ~/Projects/opencode-doobidoo-plugin
workspace:agent-toolbox               — ~/Projects/agent-toolbox
```

**Pravidlo přiřazení:**
- `type:identity`, `type:environment`, `type:preference`, `type:gotcha` → vždy `workspace:global`
- `type:lesson`, `type:procedure`, `type:summary` → `workspace:<název>` odvozený z `directory`

### Potřebné změny v pluginu

Plugin má přístup k `directory` (proměnná `workDir` v `session.idle`, řádek ~329 v `memory-hooks.ts`). Při ukládání se používá jen v textu summary, ne jako tag. Při vyhledávání se nepoužívá vůbec.

**Změna 1 — při ukládání:** automaticky přidat `workspace:<název>` tag odvozený z `directory`:

```typescript
// Derivace workspace tagu z directory path
function workspaceTag(dir: string): string {
  if (!dir || dir === "unknown") return "workspace:global"
  const name = dir.split("/").filter(Boolean).pop() ?? "global"
  return `workspace:${name}`
}

// Při ukládání session summary:
tags.push(workspaceTag(workDir))
```

**Změna 2 — při vyhledávání:** boost pro memories tagované aktuálním workspace. Doobidoo API aktuálně nepodporuje boost-by-tag při semantic search — toto by vyžadovalo:
- buď rozšíření API (`/api/search` s `boost_tags` parametrem),
- nebo post-processing na straně pluginu: vyhledat víc kandidátů, re-rankovat podle workspace tagu.

**Mezitímní řešení bez změny API:** přidat název workspace do search query jako suffix:

```typescript
// Aktuálně:
searchMemories(msgText, MEMORY_INJECT_LIMIT)

// S workspace hint:
const workspaceName = directory?.split("/").pop() ?? ""
const queryWithHint = workspaceName
  ? `${msgText} [workspace: ${workspaceName}]`
  : msgText
searchMemories(queryWithHint, MEMORY_INJECT_LIMIT)
```

Embedding model zachytí workspace název jako součást sémantiky — memories z odpovídajícího workspace budou mít vyšší similarity score, pokud jejich obsah workspace název obsahuje (a session summaries ho vždy obsahují přes `workDir` v textu).

### Dopad

| Scénář | Bez workspace tag | S workspace tag |
|---|---|---|
| Pracuji v `opencode-doobidoo-plugin`, ptám se na "jak funguje plugin inject" | Vrátí obecné memories o pluginu | Vrátí + boost pro memories z tohoto workspace |
| Spustím OpenCode v `agent-toolbox`, nová session | Session summary uložena bez rozlišení | Session summary tagována `workspace:agent-toolbox` |
| Hledám lesson z minulé práce na konkrétním projektu | Možná najde, záleží na sémantice | Přirozeně upřednostní memories ze stejného workspace |

---

## Odhad dopadu

| Příležitost | Odhadovaný počet entries | Dopad na kvalitu agenta |
|---|---|---|
| Identity + environment (scope:always) | 5–8 | Vysoký — kontext vždy přítomen |
| GWS gotchas + procedures | 8–12 | Vysoký — hlavní agent dostane GWS kontext |
| Top changelogs lessons (memory/gws/opencode) | 40–60 | Střední–Vysoký — nahrazuje manuální hledání |
| Zbytek changelogů (system/tools) | 20–40 | Střední — záložní znalostní báze |
| Workspace tagging (nové entries) | — | Střední — lepší relevance při focus práci |
| Workspace query hint (změna pluginu) | — | Střední — boost pro aktuální projekt |
| **Celkem nových entries** | **~80–120** | |

Aktuální DB: 756 entries, ~251 session summaries, ~398 compaction lessons (mechanické). Přidání 80–120 cílených knowledge entries by výrazně zlepšilo poměr signal/noise. Workspace tagging dále zlepší relevanci bez nárůstu počtu entries.
