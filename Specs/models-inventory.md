# Přehled modelů v doobidoo — inventory

**Datum:** 2026-05-07  
**Kontext:** Popis všech tří aktivních modelů v doobidoo memory pipeline — k čemu slouží, jak fungují, příklady

---

## Přehled pipeline

```
ULOŽENÍ MEMORY:
  text → all-MiniLM-L6-v2 → vektor → uložen do SQLite
  text → DeBERTa → quality_score → uložen k memory

ČTENÍ MEMORY (retrieve_memory):
  query → all-MiniLM-L6-v2 → vektor dotazu
        → sqlite-vec najde top-N nejbližších vektorů
        → MS-MARCO re-rankuje kandidáty podle relevance
        → vrátí seřazené výsledky s similarity_score
```

---

## 1. all-MiniLM-L6-v2

**HF repo:** `sentence-transformers/all-MiniLM-L6-v2`  
**Typ:** Bi-encoder (embedding model)  
**Velikost:** 22M parametrů, výstupní vektor 384 čísel  
**Role:** Převod textu na vektory — základ pro semantic search  
**Kdy běží:** Při každém uložení memory i při každém dotazu  

### Jak funguje

Model převede libovolný text na vektor 384 čísel, který zachycuje *smysl* textu. Texty s podobným smyslem mají blízké vektory — i v různých jazycích.

```
"systemd restart service"  →  [0.12, -0.34, 0.87, ...]  (384 čísel)
"jak restartovat službu"   →  [0.11, -0.31, 0.85, ...]  (384 čísel)  ← podobné!
"recept na svíčkovou"      →  [-0.45, 0.23, -0.12, ...]              ← vzdálené
```

Postup transformace:
```
text → tokenizace → 6 vrstev transformer attention → mean pooling → L2 normalizace → vektor
```

### Příklad — jak similarity_score vzniká

```
Uložené memory:
  M1: "systemd service restart after reboot"  →  vektor_M1
  M2: "python packaging tips"                 →  vektor_M2
  M3: "jak funguje systemd unit file"         →  vektor_M3

Dotaz: "systemd"  →  vektor_dotaz

Výsledky (kosínová vzdálenost):
  M1: similarity_score = 0.91  ← velmi blízké
  M3: similarity_score = 0.87  ← blízké
  M2: similarity_score = 0.23  ← vzdálené, pod prahem 0.55 → odfiltrováno
```

`similarity_score` **není uložená hodnota** — počítá se dynamicky při každém dotazu. Stejná memory může mít při jiném dotazu jiné skóre.

---

## 2. DeBERTa (nvidia/quality-classifier-deberta)

**HF repo:** `nvidia/quality-classifier-deberta`  
**Typ:** Klasifikátor (transformer fine-tuned na kvalitu textu)  
**Velikost:** ~712 MB ONNX model  
**Role:** Absolutní hodnocení kvality textu při uložení  
**Kdy běží:** Při ukládání memory a při batch re-score (lazy reindexace)  

### Jak funguje

DeBERTa byl fine-tunovaný na rozlišení kvalitního vs. nekvalitního textu (trénink na web/akademickém obsahu). Vrací label `Low / Medium / High` převedený na numerické skóre 0.0–1.0.

```
Vstup: text memory (bez query kontextu)

"Session summary (2026-05-07): Working directory: ~/Projects..."
  → DeBERTa → label: High → score: 0.82

"ok"
  → DeBERTa → label: Low  → score: 0.05
```

### Příklad — fallback thresholds

```
DeBERTa score >= 0.4  →  použije se DeBERTa score
DeBERTa score <  0.4  →  zkusí MS-MARCO rescue
  MS-MARCO score >= 0.7  →  použije se MS-MARCO score
  MS-MARCO score <  0.7  →  ponechá se DeBERTa score (i nízký)
```

### Důležité omezení

DeBERTa byl trénovaný na web a akademický text — osobní poznámky, session summaries a krátké faktické záznamy skóruje nízko (avg ~0.03–0.10). Je to očekávané chování, ne bug. `quality_score` tak odráží "jak moc vypadá text jako web/akademický článek", ne "jak moc je memory pro uživatele užitečná".

---

## 3. MS-MARCO (cross-encoder/ms-marco-MiniLM-L-6-v2)

**HF repo:** `cross-encoder/ms-marco-MiniLM-L-6-v2`  
**Typ:** Cross-encoder (model hodnotící dvojici query + dokument)  
**Velikost:** menší ONNX model  
**Role:** Re-ranking kandidátů podle relevance k aktuálnímu dotazu  
**Kdy běží:** Při čtení memory (retrieve_memory) — hodnotí top kandidáty z embedding search  

### Jak funguje

Na rozdíl od all-MiniLM (který hodnotí texty nezávisle) MS-MARCO dostane **dvojici** (query, dokument) a vrátí skóre relevance. Vidí kontext obou najednou → přesnější hodnocení.

```
Vstup: (query, kandidát) jako dvojice

("systemd restart", "systemd service restart after reboot") → score: 0.94
("systemd restart", "python packaging tips")               → score: 0.02
("python pip install", "python packaging tips")            → score: 0.89
```

### Příklad — role v pipeline

```
Dotaz: "jak nakonfigurovat systemd service"

1. all-MiniLM najde top-10 kandidátů podle vektorové vzdálenosti:
   [M1: 0.91, M3: 0.87, M7: 0.81, M2: 0.74, ...]

2. MS-MARCO re-rankuje každý kandidát s query:
   M1: ("jak nakonfigurovat...", "systemd unit file syntax")   → 0.95
   M7: ("jak nakonfigurovat...", "systemd restart po rebootu") → 0.61
   M3: ("jak nakonfigurovat...", "jak funguje systemd unit")   → 0.88
   M2: ("jak nakonfigurovat...", "python packaging")           → 0.03

3. Výsledek: M1, M3 (vysoké), M7 (střední), M2 odfiltrováno
```

### Důležité omezení

MS-MARCO s prázdným query (`""`) vrací vždy `0.0` — má early return pro prázdný vstup. Musí dostat realistický query string.

---

## Srovnání — kdy použít který model

| Vlastnost | all-MiniLM-L6-v2 | DeBERTa | MS-MARCO |
|---|---|---|---|
| Vstup | jeden text | jeden text | dvojice (query, text) |
| Výstup | vektor 384 čísel | quality score 0–1 | relevance score 0–1 |
| Kdy | vždy (zápis i čtení) | při zápisu / reindexaci | při čtení |
| Co hodnotí | sémantická vzdálenost | absolutní kvalita textu | relevance k dotazu |
| Rychlost | fast (bi-encoder) | střední (offline) | pomalejší (cross-encoder) |
| Query-dependent | ne | ne | ano |
