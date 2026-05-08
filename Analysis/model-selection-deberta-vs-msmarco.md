# Výběr modelu pro quality scoring: DeBERTa vs. MS-MARCO

**Datum rozhodnutí:** 2026-05-08  
**Výsledek:** MS-MARCO single-model, DeBERTa odstraněn

---

## Kontext

`mcp-memory-service` (doobidoo) podporuje lokální kvalitní hodnocení paměťových záznamů pomocí
ONNX modelů. Výchozí konfigurace zahrnuje dvě vrstvy:

1. **DeBERTa** — `nvidia/quality-classifier-deberta` (712 MB) — klasifikátor kvality textu
2. **MS-MARCO** — `cross-encoder/ms-marco-MiniLM-L-6-v2` — cross-encoder trénovaný na
   query-document relevanci

V produkci jsme zjistili, že DeBERTa generuje neinformativní skóre pro agent snippety.
Tato analýza dokumentuje rozhodnutí přejít na MS-MARCO jako single model.

---

## Problém s DeBERTa

### Charakteristika modelu

DeBERTa (`nvidia/quality-classifier-deberta`) je trénovaný na webovém a akademickém textu
(Wikipedia, novinové články, odborné publikace). Vstupní doménou jsou ucelené odstavce
v přirozeném jazyce.

### Chování na agent snippetech

Agent snippety (paměťové záznamy z OpenCode sessions) mají jiný charakter:

- Krátké technické poznámky: *"MS-MARCO single model + FALLBACK=false eliminuje potřebu patche"*
- Záznamy o zjištěních: *"quality_score=0.0 po store neblokuje retrieval — vector distance řídí retrieve"*
- Konfigurace a příkazy: *"mcp-memory-http.service je název systemd user unit"*

**Naměřená skóre DeBERTa pro agent snippety: 0.03–0.10**

Toto skóre je prakticky konstantní bez ohledu na skutečnou hodnotu záznamu. Model nedokáže
rozlišit hodnotnou lekci od triviální poznámky, protože ani jedna z nich neodpovídá jeho
trénovací doméně.

### Dopad na retention pipeline

`quality_score < 0.5` → retention tier "low" → 30–90 dní  
S DeBERTa skóroval každý záznam pod 0.1 → veškerý obsah by byl klasifikován jako
nízkokvaliní s maximální retention 90 dní.

---

## MS-MARCO jako alternativa

### Charakteristika modelu

`cross-encoder/ms-marco-MiniLM-L-6-v2` je cross-encoder trénovaný na Microsoft MARCO
dataset — kolekci párů (query, dokument) z reálného vyhledávání. Model odhaduje
relevanci dokumentu vůči konkrétnímu dotazu.

**Velikost:** ~22 MB (vs. 712 MB pro DeBERTa)

### Chování na agent snippetech

MS-MARCO hodnotí každý záznam v kontextu dotazu. Při `BOOST_ENABLED=true`:

- Při **store**: `query=""` → skóre 0.0 (hardcoded v knihovně, nelze změnit bez patche)
- Při **retrieve**: skutečný dotaz → skóre 0.0–1.0 podle relevance

Naměřená skóre po rescore s historickými dotazy:
- Průměr: 0.3519
- Vysoké (≥ 0.7): 176 záznamů (23 %)
- Střední (0.5–0.7): 59 záznamů (8 %)
- Nízké (< 0.5): 541 záznamů (70 %)

Distribuce odpovídá očekávání — ne každá paměť je relevantní ke každému dotazu.
Při konkrétním dotazu skóre stoupá pro relevantní záznamy.

---

## Analýza store-time skóre 0.0

### Je store-time 0.0 problém?

**Retrieval:** Nikoliv. `retrieve_memory()` řadí výsledky primárně podle `e.distance`
(embedding distance) — `quality_score` není součástí SQL ORDER BY ani post-processingového
řazení v základním retrieve.

**Retrieve with boost:** Skóre se opraví při prvním retrieve s reálným dotazem.
`MCP_QUALITY_BOOST_ENABLED=true` zajišťuje, že každé retrieve rescoruje záznamy.

**Forgetting pipeline:** Potenciální problém — záznamy se `quality_score=0.0` by teoreticky
mohly být klasifikovány jako "low retention". V praxi:
- Forgetting scheduler je defaultně vypnutý (`MCP_FORGETTING_ENABLED=false`)
- Deletion nastane pouze pro `potential_duplicate` + překročení retention limitu
- Po prvním retrieve se skóre opraví

**Doporučení:** Spustit `scripts/rescore.py` po migraci nebo větším importu záznamů,
aby se store-time 0.0 nahradilo reálnými skóre před aktivací forgetting pipeline.

---

## Rozhodnutí a konfigurace

### Finální konfigurace

```bash
export MCP_QUALITY_SYSTEM_ENABLED=true
export MCP_QUALITY_AI_PROVIDER=local
export MCP_QUALITY_LOCAL_MODEL="ms-marco-MiniLM-L-6-v2"
export MCP_QUALITY_LOCAL_DEVICE=auto
export MCP_QUALITY_FALLBACK_ENABLED=false   # žádný DeBERTa fallback
export MCP_QUALITY_BOOST_ENABLED=true       # rescore při každém retrieve
```

`MCP_QUALITY_FALLBACK_ENABLED=false` zabraňuje fallbacku na DeBERTa v případě, že
by byl model dostupný. Bez tohoto nastavení by knihovna mohla tiše přepnout na DeBERTa.

### Proč ne patch `ai_evaluator.py`?

Dřívější přístup zahrnoval patch souboru `ai_evaluator.py` pro fixování fallback chování.
Přepnutím na single model s `FALLBACK_ENABLED=false` je patch zbytečný — konfigurace
samotná eliminuje nežádoucí chování. Patch je archivován v `patches/attic/`.

### Omezení a kompromisy

| Aspekt | DeBERTa | MS-MARCO |
|--------|---------|----------|
| Velikost modelu | 712 MB | ~22 MB |
| Store-time scoring | 0.03–0.10 (neinformativní) | 0.0 (query="" fallback) |
| Retrieve-time scoring | 0.03–0.10 (neinformativní) | 0.0–1.0 (reálná relevance) |
| Trénovací doména | webový/akademický text | query-document retrieval |
| Vhodnost pro agent snippety | nízká | vysoká |
| Paměťové nároky (RAM) | ~1.4 GB | ~44 MB |

---

## Závěr

MS-MARCO je vhodný model pro quality scoring agent paměťových záznamů. Skóre je
query-aware, což odpovídá use casu — relevance paměti závisí na kontextu dotazu,
ne na absolutní "kvalitě textu". DeBERTa je nevhodný pro krátké technické snippety.

Store-time skóre 0.0 je přijatelný kompromis: retrieval jde primárně přes embedding
distance, BOOST mechanismus zajistí opravu skóre při prvním retrieve. Pro aktivaci
forgetting pipeline je doporučeno předem spustit `scripts/rescore.py`.
