# Integrace opencode-doobidoo-plugin s mcp-memory-service

**Datum:** 2026-05-08  
**Kontext:** Jak plugin komunikuje s doobidoo, jaké API volá, kdy a s jakými daty

---

## Přehled architektury

```
OpenCode session
    │
    ├── [messages.transform]   → retrieve_memory(query) → pendingMemoryBlock
    ├── [system.transform]     → inject pendingMemoryBlock do system promptu
    ├── [tool.execute.after]   → sledování změněných souborů
    ├── [session.idle]         → store_memory(summary / lessons)
    └── [session.compacting]   → rozšíření compaction promptu
         └── [session.idle po compacting] → extract lessons z compaction summary
```

Plugin komunikuje s doobidoo výhradně přes REST API (`DOOBIDOO_API_URL`, výchozí
`http://localhost:8000/api`). Žádný přímý přístup k SQLite DB ani k Python kódu služby.

---

## API endpointy použité pluginem

### GET `/health`

**Kdy:** session start (pre-warm)  
**Účel:** Ověření dostupnosti služby, zahřátí modelu

```typescript
await fetch(`${API_URL.replace('/api', '')}/health`)
```

Pokud selže, plugin zaloguje varování a pokračuje (žádný crash).

---

### POST `/api/memories/search`

**Kdy:** `messages.transform` — při každém LLM callu  
**Účel:** Sémantické vyhledávání relevantních pamětí pro aktuální kontext

**Request:**
```json
{
  "query": "<text posledních zpráv ze sessiony, max ~500 znaků>",
  "n_results": 7,
  "similarity_threshold": 0.55
}
```

Parametry jsou konfigurovatelné přes env proměnné:
- `MEMORY_INJECT_LIMIT` (výchozí: 7) — počet vrácených záznamů
- `MEMORY_MIN_SCORE` (výchozí: 0.55) — minimální similarity threshold

**Response:**
```json
[
  {
    "content": "text paměti",
    "tags": ["tag1", "tag2"],
    "metadata": { "quality_score": 0.72 },
    "similarity": 0.83,
    "id": "abc123..."
  }
]
```

**Deduplikace:** Plugin sleduje `content_hash` injektovaných pamětí v rámci sessiony
(uloženo v `pendingMemoryBlock.hashes`). Duplicity se nepřidají do kontextu, i když
API vrátí stejný záznam vícekrát.

---

### POST `/api/memories`

**Kdy:** `session.idle` — po skončení/odmlčení sessiony  
**Účel:** Uložení session summary nebo lessons learned

**Request:**
```json
{
  "content": "text paměti",
  "tags": ["session_summary", "files-changed"],
  "metadata": {}
}
```

**Autorizace:** `Authorization: Bearer <token>` z `MEMORY_API_KEY` nebo ze souboru
`~/.config/opencode/secrets/memory-api-key`.

**Typy ukládaných pamětí:**

| Typ | Tagy | Podmínka |
|-----|------|----------|
| Session summary | `session_summary`, `files-changed` | Session s editovanými soubory |
| Conversation summary | `conversation_summary`, `conversation` | Konverzační session (> 300 znaků asistent. textu) |
| Lesson learned | `lessons-learned`, `compaction-extracted` | Extrahováno z compaction summary |

---

## Subagent detekce — skip inject

Plugin kontroluje `session.parentID` v `system.transform`. Pokud je přítomno
(session je spuštěna přes Task tool), inject pamětí se přeskočí.

**Důvod:** Subagenti dostávají explicitní instrukce v promptu. Injekce obecných pamětí
by mohla způsobit konflikty nebo zmást kontext.

**Implementace:** `client.session.get()` → kontrola `parentID` field.

---

## Two-phase inject mechanismus

Inject probíhá ve dvou krocích, aby byl zaručen správný pořadí:

```
1. messages.transform   → spustí async search → uloží výsledky do pendingMemoryBlock
2. system.transform     → přidá pendingMemoryBlock na konec system promptu
```

`messages.transform` se volá dříve než `system.transform`, takže výsledky search jsou
připraveny před sestavením finálního system promptu. Paměti jsou přidány *za* všemi
ostatními instrukcemi.

---

## Compaction integrace

Při `session.compacting` plugin rozšíří compaction prompt o instrukci:
```
## LESSONS LEARNED
Extrahuj lekce ve formátu: "Expected X, found Y → do Z next time"
```

Na dalším `session.idle` po compaction plugin prohledá výstup compaction summary,
najde sekci `## LESSONS LEARNED` a uloží každou lekci jako samostatnou paměť
s tagem `compaction-extracted`.

---

## Konfigurace

| Proměnná | Výchozí | Popis |
|----------|---------|-------|
| `DOOBIDOO_API_URL` | `http://localhost:8000/api` | Base URL doobidoo REST API |
| `MEMORY_API_KEY` | čte z `~/.config/opencode/secrets/memory-api-key` | Bearer token pro write operace |
| `MEMORY_MIN_SCORE` | `0.55` | Minimální similarity score pro vyhledávání |
| `MEMORY_INJECT_LIMIT` | `7` | Max počet pamětí injektovaných do kontextu |

---

## Závislosti a předpoklady

1. **doobidoo HTTP server** musí běžet před startem OpenCode session
   - `systemctl --user start mcp-memory-http.service`
   - Plugin pre-warm selže tiše (žádný crash)

2. **Konfigurace quality scoringu** — viz `Analysis/model-selection-deberta-vs-msmarco.md`
   a sekci "Service Configuration" v README.md

3. **Bearer token** — write operace (store) vyžadují autentizaci.
   Read operace (search) autentizaci nevyžadují.

---

## Relacionované dokumenty

- `Specs/memory-data-structure.md` — schéma memory objektu
- `Specs/embedding-and-semantic-search.md` — jak funguje sémantické vyhledávání
- `Analysis/model-selection-deberta-vs-msmarco.md` — výběr quality scoring modelu
- `scripts/rescore.py` — batch rescoring existujících pamětí
- `README.md` → sekce "Service Configuration" — env proměnné pro doobidoo
