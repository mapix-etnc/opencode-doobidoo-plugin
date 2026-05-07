# Struktura memory objektu — datové schéma

**Datum:** 2026-05-07  
**Kontext:** Kompletní schéma memory záznamu v doobidoo, včetně metadata substruktury a heuristiky pro identifikaci původu

---

## Kompletní schéma

```json
{
  "content":       "string  — samotný text memory",
  "content_hash":  "string  — SHA-256 otisk obsahu (slouží jako dedup klíč)",
  "tags":          ["string", "..."],
  "memory_type":   "string  — vždy 'observation' (nediferencuje zdroj)",
  "created_at":    "float   — Unix timestamp uložení",
  "created_at_iso":"string  — ISO 8601 (UTC)",
  "updated_at":    "float   — Unix timestamp poslední aktualizace",
  "updated_at_iso":"string  — ISO 8601 (UTC)",
  "metadata": {
    "quality_score":    "float   — výsledné quality skóre (0.0–1.0)",
    "quality_provider": "string  — kdo naposledy skóroval",
    "ai_scores": [
      {
        "score":     "float   — raw AI skóre z modelu",
        "timestamp": "float   — Unix timestamp přeskórování",
        "provider":  "string  — název providera"
      }
    ],
    "quality_components": {
      "ai_score":      "float  — skóre z AI modelu (DeBERTa / MS-MARCO)",
      "implicit_score":"float  — implicitní skóre z chování (access_count, recency)",
      "boost_enabled": "bool   — zda je BOOST aktivní",
      "boost_weight":  "float  — váha boostu při výpočtu výsledného skóre"
    },
    "access_count":      "int    — kolikrát byla memory načtena při vyhledávání",
    "last_accessed_at":  "float  — Unix timestamp posledního načtení",
    "access_queries": [
      {
        "query":     "string  — text dotazu který memory vytáhl",
        "timestamp": "float   — Unix timestamp tohoto přístupu"
      }
    ]
  }
}
```

---

## Popis jednotlivých polí

### Základní pole

| Pole | Typ | Popis |
|---|---|---|
| `content` | string | Samotný text uložené memory |
| `content_hash` | string | SHA-256 otisk — slouží k deduplikaci při ukládání i při inject do kontextu |
| `tags` | string[] | Pole tagů — primární způsob kategorizace, viz níže |
| `memory_type` | string | Vždy `"observation"` — nediferencuje zdroj uložení |
| `created_at` | float | Unix timestamp prvního uložení |
| `updated_at` | float | Unix timestamp poslední změny (přeskórování neaktualizuje) |

### metadata.quality_score

Výsledné skóre je **kompozitní** — kombinuje AI skóre a implicitní signály:

```
quality_score = (1 - boost_weight) * ai_score + boost_weight * implicit_score

Příklad:
  ai_score      = 0.006  (DeBERTa — krátký faktický text)
  implicit_score= 0.54   (11 přístupů, recentní)
  boost_weight  = 0.30

  quality_score = 0.70 * 0.006 + 0.30 * 0.54 = 0.166
```

### metadata.quality_provider

Hodnoty které se mohou vyskytovat:

| Hodnota | Popis |
|---|---|
| `onnx_local` | DeBERTa nebo MS-MARCO, starší záznamy před fallback módem |
| `fallback_deberta-msmarco` | Fallback pipeline (DeBERTa + MS-MARCO rescue) — aktivní od 2026-05-06 |

### metadata.ai_scores[]

Historie všech přeskórování — přidává se nový záznam při každém re-score (batch reindexace, BOOST při retrieval). Umožňuje sledovat vývoj skóre v čase.

### metadata.implicit_score

Počítá se z chování uživatele — není přímo uložen, ale je součástí `quality_components`. Vychází z:
- `access_count` — kolikrát byla memory načtena
- recency — jak nedávno k přístupu došlo

Čím více a čím nedávněji byla memory používána, tím vyšší `implicit_score`.

### metadata.access_queries[]

**Jediná stopa životní historie memory po uložení.** Zaznamenává každý dotaz, který danou memory vrátil při vyhledávání. Umožňuje zjistit, v jakých kontextech je memory relevantní.

---

## Heuristika pro identifikaci původu memory

V DB **neexistuje** pole `source` ani `ingested_via` — původ se pozná nepřímo:

| Indikátor | Pravděpodobný původ |
|---|---|
| Tag `compaction-extracted` + tag `lessons-learned` | Plugin — extrakce po compaction (`session.compacting` → `session.idle`) |
| Tag `session` + content začíná `"Session summary"` | Plugin — automatické uložení po skončení session (`session.idle`) |
| Tag `preference` nebo `identity` + krátký faktický text | Agent přes MCP — vědomé volání `memory_store` |
| Tag `changelog`, `beads`, `opencode`, `git` apod. | Agent přes MCP — vědomé volání s explicitními tagy |
| `quality_provider = "onnx_local"` v prvním `ai_scores` záznamu | Uloženo před 2026-05-06 (před nasazením fallback pipeline) |
| `quality_provider = "fallback_deberta-msmarco"` | Uloženo nebo přeskórováno po 2026-05-06 |

---

## Reálný příklad — memory uložená přes MCP

```json
{
  "content": "User preference: MR/PR na GitLabu/GitHubu vytváří jen uživatel, ne agent. Agent smí: commit, push na feature branch. Agent nesmí: otevřít MR bez explicitního pokynu uživatele.",
  "content_hash": "29a68cc2061d1004d921ff8f0ce9202d4721441fd4c3f524001b34225bf1372b",
  "tags": ["preference", "git", "gitlab", "session"],
  "memory_type": "observation",
  "created_at_iso": "2026-04-07T12:32:01.474604Z",
  "metadata": {
    "quality_score": 0.166,
    "quality_provider": "fallback_deberta-msmarco",
    "ai_scores": [
      { "score": 0.00633, "timestamp": 1778020098, "provider": "onnx_local" },
      { "score": 0.00633, "timestamp": 1778056061, "provider": "fallback_deberta-msmarco" }
    ],
    "quality_components": {
      "ai_score": 0.00633,
      "implicit_score": 0.5397,
      "boost_enabled": true,
      "boost_weight": 0.3
    },
    "access_count": 11,
    "last_accessed_at": 1777584617,
    "access_queries": [
      { "query": "uživatel preference technologie stack workflow", "timestamp": 1776165311 },
      { "query": "Kdo je uživatel?", "timestamp": 1777107237 }
    ]
  }
}
```

**Poznámka:** Přes nízké AI skóre (0.006 — DeBERTa hodnotí osobní poznámky nízko) je výsledné `quality_score` 0.166 díky vysokému `implicit_score` (0.54) z 11 přístupů. Jde o přirozený výsledek BOOST mechanismu.

---

## Aktuální stav tagů v DB (k 2026-05-07, celkem 756 memories)

| Tag | Počet | Zdroj |
|---|---|---|
| `lessons-learned` | 577 | Plugin (session.idle + compaction) |
| `compaction-extracted` | 398 | Plugin (compaction) |
| `session` | 251 | Plugin (session.idle) |
| `files-changed` | 154 | Plugin (session.idle — kódové sessions) |
| `bash` | 76 | Plugin (session.idle — použit bash tool) |
| `conversation` | 40 | Plugin (session.idle — konverzační sessions) |
| `opencode` | 39 | Agent přes MCP |
| `changelog` | 19 | Agent přes MCP |
| `beads` | 15 | Agent přes MCP |
| `mcp` | 10 | Agent přes MCP |
| `preference` | 2 | Agent přes MCP |
| `identity` | 0 | — nikdy nepoužit |
