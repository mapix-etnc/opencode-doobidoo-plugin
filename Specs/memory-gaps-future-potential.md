# Potenciální mezery v pokrytí paměti — budoucí rozvoj

**Datum analýzy:** 2026-05-07  
**Kontext:** Analýza cyklu uživatel ↔ paměť ↔ agent v pluginu `memory-hooks.ts`

---

## Co je aktuálně pokryto

```
USER → prompt → [plugin: search] → inject do system promptu → AGENT
AGENT → write/edit → [plugin: track] → session idle → [plugin: uloží summary]
AGENT → compaction → [plugin: LESSONS LEARNED] → idle → [plugin: extrahuje lessons]
```

Plugin zajišťuje automatický inject při čtení a ukládání při každém idle — bez vědomé účasti agenta.

---

## Identifikované mezery

### 1. Ukládání ze strany uživatele

Uživatel nemůže přímo „přidat memory" bez toho, aby to agent zavolal přes MCP. Pokud uživatel řekne „zapamatuj si X", záleží výhradně na tom, zda agent vědomě zavolá `memory_store`. Žádný dedikovaný mechanismus pro přímé ukládání z promptu neexistuje.

**Potenciál:** Hook na specifický vzor v promptu (např. „zapamatuj si…", „poznamenej…") → automatické uložení bez nutnosti agentova rozhodnutí.

---

### 2. Kvalita session summary

Plugin ukládá session summary jako prostý text složený z posledních 3 asistentových zpráv (max 800 znaků). U komplexních sessions může být summary neúplná nebo nevýznamná. Agent nemá explicitní instrukci, aby na konci session napsal strukturovaný výstup.

**Potenciál:** Přidat do system promptu instrukci pro strukturovaný závěr session (cíl, co bylo uděláno, klíčová rozhodnutí, další kroky). Plugin by mohl tento blok extrahovat cíleně — stejně jako dnes extrahuje `## LESSONS LEARNED`.

---

### 3. Inject je query-dependent — vágní začátek konverzace

Inject hledá memories relevantní k aktuálnímu promptu. Pokud uživatel začne konverzaci vágně (`„pokračuj"`, `„co jsme dělali?"`, `„What did we do so far?"`), query je slabý → semantic search vrátí málo nebo nic → kontext chybí. Fallback na `getRecentSessionMemories()` nastane jen pokud semantic vrátí < 2 výsledky (`MEMORY_FALLBACK_THRESHOLD = 2`).

**Potenciál:** Detekovat krátké/vágní prompty a automaticky rozšířit fallback — např. vždy přidat poslední N session summaries pokud je prompt kratší než určitý threshold.

---

### 4. Agent neví, co bylo injektováno

Agent vidí memories v system promptu, ale neví, které konkrétní záznamy tam jsou, ani zda jsou pro daný kontext relevantní. Pokud by chtěl stav paměti ověřit, musí volat `retrieve_memory` — ale nemá k tomu důvod, protože neví, co mu případně chybí.

**Potenciál:** Přidat do injektovaného bloku metadata (počet, kategorie, nejstarší/nejnovější datum) aby agent mohl posoudit, zda kontext je dostatečný, a případně si aktivně doplnit chybějící paměti.

---

### 5. Žádný feedback loop při opravě agenta

Pokud agent udělá chybu a uživatel ji opraví, tato korekce se do paměti dostane jen náhodně — pokud ji session summary zachytí, nebo pokud agent vědomě zavolá `memory_store`. Plugin nemá žádný hook na událost „uživatel opravil agenta".

**Potenciál:** Detekovat v konverzaci vzory oprav (uživatel neguje předchozí odpověď agenta) a automaticky uložit opravenou verzi jako `correction` memory s příslušnými tagy.

---

### 6. Subagenti jsou záměrně vynecháni z injectu

Plugin záměrně skipuje inject pro subagent sessions (kontrola `parentID`, řádek ~554 v `memory-hooks.ts`). Subagenti tedy memories nedostanou ani nic neuloží — to je záměrný design, ale vytváří slepé místo: subagent pracující na složitém podúkolu nemá přístup ke kontextu, který by mu mohl pomoci.

**Potenciál:** Selektivní inject pro subagenty — ne plný kontext, ale cílené předání relevantních memories na základě subagentova systémového promptu nebo zadání. Případně umožnit hlavnímu agentovi explicitně předat memories subagentovi jako součást jeho instrukce.

---

## Prioritizace (návrh)

| Mezera | Dopad | Složitost |
|--------|-------|-----------|
| 3. Vágní začátek konverzace | Vysoký — běžný use case | Nízká |
| 2. Kvalita session summary | Střední — závisí na délce sessions | Střední |
| 1. Ukládání ze strany uživatele | Střední — obchází se přes agenta | Nízká |
| 5. Feedback loop oprav | Střední — dlouhodobá kvalita paměti | Vysoká |
| 4. Transparentnost injectu pro agenta | Nízký — agent funguje i bez toho | Nízká |
| 6. Subagenti bez kontextu | Nízký — záměrný design | Vysoká |
