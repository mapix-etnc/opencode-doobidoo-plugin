# Embedding a sémantické vyhledávání — jak to funguje

**Datum:** 2026-05-07  
**Kontext:** Vysvětlení role modelu `all-MiniLM-L6-v2` v doobidoo memory pipeline

---

## Co je embedding

Embedding je způsob, jak převést text na čísla — konkrétně na **vektor** (seznam čísel), který zachycuje *význam* textu, ne jen jeho písmena.

Příklad:
```
"systemd restart service"  →  [0.12, -0.34, 0.87, 0.05, ...]  (384 čísel)
"jak restartovat službu"   →  [0.11, -0.31, 0.85, 0.06, ...]  (384 čísel)
"recept na svíčkovou"      →  [-0.45, 0.23, -0.12, 0.78, ...]  (384 čísel)
```

První dvě věty mají **podobná čísla** (blízké vektory) i přestože jsou v jiném jazyce. Třetí věta je úplně jinde. Vzdálenost ve vektorovém prostoru = sémantická podobnost.

---

## Jak all-MiniLM-L6-v2 převádí text na vektory

Model je neuronová síť (transformer) trénovaná na milionech dvojic vět. Naučila se, které věty mají podobný *smysl*.

Postup při každém volání:

```
1. Text → tokenizace (slova → čísla)
        "systemd restart" → [101, 9002, 8714, 102]

2. Tokeny → transformer (6 vrstev attention)
        každý token "komunikuje" se všemi ostatními
        → zachytí kontext, vztahy, smysl

3. Výstup → průměr přes všechny tokeny (mean pooling)
        → jeden vektor 384 čísel pro celý text

4. L2 normalizace → délka vektoru = 1
        → kosínová vzdálenost = skalární součin
```

- „Mini" = malý model (22M parametrů)
- „L6" = 6 vrstev transformeru
- „v2" = druhá verze

Rychlý a kompaktní, přesto sémanticky přesný.

---

## Jak funguje semantic search

Doobidoo používá **sqlite-vec** — SQLite rozšíření pro vektorové vyhledávání.

```
ULOŽENÍ MEMORY:
  text → all-MiniLM-L6-v2 → vektor [384 čísel]
  → uloží se do SQLite tabulky (text + vektor vedle sebe)

VYHLEDÁVÁNÍ (retrieve_memory):
  query → all-MiniLM-L6-v2 → vektor dotazu
  → sqlite-vec spočítá kosínovou vzdálenost
    mezi query vektorem a VŠEMI uloženými vektory
  → vrátí top-N nejbližších seřazených od nejvyššího score
  → plugin filtruje: score >= MEMORY_MIN_SCORE (0.55)
```

**Kosínová vzdálenost** = úhel mezi dvěma vektory. Čím menší úhel (čím více „míří stejným směrem"), tím podobnější smysl.

### Důležité: similarity_score není uložená hodnota

`similarity_score` se **počítá dynamicky při každém dotazu** jako vzdálenost mezi query vektorem a vektorem dané memory. Každý dotaz může vrátit stejnou memory s **jiným score** — záleží na tom, jak blízko je dotaz té konkrétní memory.

---

## Co se reálně injektuje do kontextu

```
Do kontextu jde (v tomto pořadí, s deduplikací přes content_hash):

  identity/preference tagy  (max 8,  bez score filtru — vždy)
  lessons-learned            (max 5,  bez score filtru)
  semantic top-N             (max 7,  score >= 0.55)
  recent sessions fallback   (max 5,  jen pokud semantic vrátí < 2 výsledky)
```

Teoretické maximum je ~25 memories, v praxi méně kvůli deduplikaci.

Konfigurace v `memory-hooks.ts`:
- `MEMORY_INJECT_LIMIT = 7`
- `MEMORY_MIN_SCORE = 0.55`
- `MEMORY_IDENTITY_LIMIT = 8`
- `MEMORY_LESSONS_LIMIT = 5`
- `MEMORY_RECENT_LIMIT = 5`
- `MEMORY_FALLBACK_THRESHOLD = 2`

---

## Vztah ke všem třem modelům

```
all-MiniLM-L6-v2   →  najde kandidáty (top ~10-20 memories pomocí vektorové vzdálenosti)
                              ↓
MS-MARCO           →  re-rankuje kandidáty podle relevance k dotazu (cross-encoder)
                              ↓
DeBERTa            →  při uložení hodnotí absolutní kvalitu textu (quality score)
```

`all-MiniLM-L6-v2` je **vstupní brána** — bez něj by semantic search vůbec nevěděl, které memories jsou tematicky blízko dotazu. DeBERTa a MS-MARCO jsou až druhá vrstva nad tím.
