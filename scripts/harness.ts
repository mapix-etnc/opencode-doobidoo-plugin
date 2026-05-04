/**
 * DoobidooMemoryPlugin — local test harness
 *
 * Simulates the OpenCode plugin runner without restarting OpenCode.
 * Uses live doobidoo API for search, intercepts POST /api/memories.
 *
 * Usage:
 *   bun run harness                    # all scenarios
 *   bun run harness inject             # specific scenario
 *   bun run harness --dry-run          # don't write to doobidoo
 *   bun run harness inject --dry-run   # combine
 */

import { DoobidooMemoryPlugin } from "../src/plugin.ts"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const scenarioFilter = args.find(a => !a.startsWith("--"))

// ---------------------------------------------------------------------------
// Captured output (reset before each scenario)
// ---------------------------------------------------------------------------
type Captured = {
  logs: Array<{ level: string; message: string; extra?: unknown }>
  toasts: string[]
  stored: Array<{ content: string; tags: string[]; memory_type: string }>
}

let captured: Captured = { logs: [], toasts: [], stored: [] }

function resetCaptured() {
  captured = { logs: [], toasts: [], stored: [] }
}

// ---------------------------------------------------------------------------
// Fetch interceptor — wrap globalThis.fetch BEFORE importing plugin
// Intercepts POST /api/memories, passes everything else through
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch

// @ts-ignore — intentional override
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  const method = (init?.method ?? "GET").toUpperCase()

  if (method === "POST" && url.includes("/api/memories") && !url.includes("/search")) {
    const body = JSON.parse((init?.body as string) ?? "{}")
    captured.stored.push({
      content: body.content ?? "",
      tags: body.tags ?? [],
      memory_type: body.memory_type ?? "observation",
    })
    if (dryRun) {
      return new Response(JSON.stringify({ id: "harness-dry-run", content_hash: "dryrun" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
  }

  return originalFetch(input as RequestInfo, init)
}

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------
let scenarioMessages: unknown[] = []

const fakeClient = {
  app: {
    log: async ({ body }: { body: { level: string; message: string; extra?: unknown } }) => {
      captured.logs.push({ level: body.level, message: body.message, extra: body.extra })
    },
  },
  tui: {
    showToast: async ({ body }: { body: { message: string } }) => {
      captured.toasts.push(body.message)
    },
  },
  session: {
    messages: async (_opts: unknown) => ({ data: scenarioMessages }),
    get: async (_opts: unknown) => ({ data: { parentID: undefined } }),
  },
}

// ---------------------------------------------------------------------------
// Message fixture helpers
// ---------------------------------------------------------------------------
function userMsg(text: string, sessionId: string, synthetic = false) {
  return {
    info: { role: "user", sessionID: sessionId },
    parts: [{ type: "text", text, synthetic }],
  }
}

function assistantMsg(text: string, sessionId: string) {
  return {
    info: { role: "assistant", sessionID: sessionId },
    parts: [{ type: "text", text }],
  }
}

// system.transform guard: MIN_CHAT_SYSTEM_CHARS = 10_000
// Fake system prompt must be ≥ 10 000 chars
const FAKE_SYSTEM_PROMPT =
  "You are OpenCode, an AI coding assistant. " +
  "x".repeat(10_000)

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function runScenario(
  name: string,
  description: string,
  fn: (hooks: Awaited<ReturnType<typeof DoobidooMemoryPlugin>>, sessionId: string) => Promise<void>,
) {
  resetCaptured()
  const sessionId = `harness-${name}-${Date.now()}`

  console.log("\n" + "═".repeat(54))
  console.log(` SCENARIO: ${name} — ${description}`)
  console.log("═".repeat(54))
  if (dryRun) console.log(" [DRY-RUN: POST /api/memories will not be written]")

  // Fresh plugin instance per scenario (resets sessionState map)
  const hooks = await DoobidooMemoryPlugin({
    client: fakeClient as Parameters<typeof DoobidooMemoryPlugin>[0]["client"],
    directory: "/var/home/mpx/Projects/opencode-doobidoo-plugin",
  })

  try {
    await fn(hooks, sessionId)

    // Print logs
    if (captured.logs.length > 0) {
      console.log("\nLogs:")
      for (const l of captured.logs) {
        console.log(`  [${l.level}] ${l.message.substring(0, 200)}`)
      }
    }

    // Print toasts
    if (captured.toasts.length > 0) {
      console.log("\nToasts:")
      for (const t of captured.toasts) {
        console.log(`  → ${t}`)
      }
    }

    // Print stored memories
    if (captured.stored.length > 0) {
      console.log("\nStored memories:")
      for (const m of captured.stored) {
        console.log(`  type=${m.memory_type} tags=[${m.tags.join(", ")}]`)
        console.log(`  content: ${m.content.substring(0, 120).replace(/\n/g, " ")}...`)
      }
    }

    console.log("\n" + "═".repeat(24) + " RESULT " + "═".repeat(22))

    // Determine pass/fail based on scenario-specific checks (set by fn via returnValue)
    console.log(`  stored: ${captured.stored.length}  toasts: ${captured.toasts.length}  logs: ${captured.logs.length}`)
    console.log("═".repeat(54))
  } catch (err) {
    console.log(`\n  ✗ ERROR: ${err}`)
    console.log("═".repeat(54))
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const scenarios: Array<{
  name: string
  description: string
  fn: (hooks: Awaited<ReturnType<typeof DoobidooMemoryPlugin>>, sessionId: string) => Promise<void>
}> = [
  // 1. inject — full inject pipeline
  {
    name: "inject",
    description: "Normal message → inject memories into system prompt",
    fn: async (hooks, sessionId) => {
      const query = "jak funguje doobidoo plugin a memory injection?"
      console.log(`\nInput: "${query}"`)

      const messages = [userMsg(query, sessionId)]

      // [1] messages.transform
      console.log("\n[1] messages.transform")
      const messagesOutput = { messages }
      await hooks["experimental.chat.messages.transform"]?.({}, messagesOutput)

      const searchLog = captured.logs.find(l => l.message.includes("search done"))
      if (searchLog) {
        console.log(`  ✓ search executed`)
        console.log(`  → ${searchLog.message.substring(0, 150)}`)
      } else {
        console.log("  - no search log (API unavailable or guard triggered?)")
      }

      // [2] system.transform
      console.log("\n[2] system.transform")
      const systemOutput = { system: [FAKE_SYSTEM_PROMPT] }
      await hooks["experimental.chat.system.transform"]?.(
        { sessionID: sessionId, model: { id: "claude-sonnet" } } as Parameters<NonNullable<typeof hooks["experimental.chat.system.transform"]>>[0],
        systemOutput,
      )

      const partsAfter = systemOutput.system.length
      if (partsAfter > 1) {
        console.log(`  ✓ memory block injected (system parts: 1 → ${partsAfter})`)
        const block = systemOutput.system[systemOutput.system.length - 1]
        console.log(`  → preview:\n${block.substring(0, 400).split("\n").map(l => "      " + l).join("\n")}`)
      } else {
        console.log("  - memory block NOT injected (pendingMemoryBlock was null)")
        console.log("    (possible: API unavailable, query too short, or all scores below threshold)")
      }
    },
  },

  // 2. guard — double-search guard
  {
    name: "guard",
    description: "Same message twice → second call skips search",
    fn: async (hooks, sessionId) => {
      const query = "jak funguje doobidoo plugin?"
      console.log(`\nInput (×2): "${query}"`)

      const messages = [userMsg(query, sessionId)]

      console.log("\n[1] First messages.transform")
      await hooks["experimental.chat.messages.transform"]?.({}, { messages })
      const logsAfterFirst = captured.logs.length
      const hasSearch1 = captured.logs.some(l => l.message.includes("search done"))
      console.log(`  ${hasSearch1 ? "✓ search executed" : "- no search (API unavailable?)"}`)

      // Reset pendingMemoryBlock by consuming it
      await hooks["experimental.chat.system.transform"]?.(
        { sessionID: sessionId, model: { id: "claude-sonnet" } } as Parameters<NonNullable<typeof hooks["experimental.chat.system.transform"]>>[0],
        { system: [FAKE_SYSTEM_PROMPT] },
      )

      console.log("\n[2] Second messages.transform (same query)")
      await hooks["experimental.chat.messages.transform"]?.({}, { messages })
      const hasSearch2 = captured.logs.slice(logsAfterFirst).some(l => l.message.includes("search done"))

      if (!hasSearch2) {
        console.log("  ✓ guard active: search skipped (same query)")
      } else {
        console.log("  ✗ guard NOT active: search ran again (unexpected)")
      }
    },
  },

  // 3. session — code session with file edits
  {
    name: "session",
    description: "Session with file edits → saves session_summary",
    fn: async (hooks, sessionId) => {
      console.log(`\nSimulating: 3 tool calls, 1 file edit, then session.idle`)

      // Simulate tool calls
      const toolInputBase = { sessionID: sessionId, callID: "call-1", args: {} }
      await hooks["tool.execute.after"]?.(
        { ...toolInputBase, tool: "read", callID: "call-1" } as Parameters<NonNullable<typeof hooks["tool.execute.after"]>>[0],
        { title: "Read file", output: "", metadata: {} },
      )
      await hooks["tool.execute.after"]?.(
        { ...toolInputBase, tool: "edit", callID: "call-2", args: { filePath: "/var/home/mpx/Projects/opencode-doobidoo-plugin/src/plugin.ts" } } as Parameters<NonNullable<typeof hooks["tool.execute.after"]>>[0],
        { title: "Edit file", output: "", metadata: {} },
      )
      await hooks["tool.execute.after"]?.(
        { ...toolInputBase, tool: "bash", callID: "call-3" } as Parameters<NonNullable<typeof hooks["tool.execute.after"]>>[0],
        { title: "Run bash", output: "", metadata: {} },
      )

      console.log("  → 3 tool calls tracked (read, edit, bash)")

      // Set up fake session messages for session.idle
      scenarioMessages = [
        userMsg("Uprav plugin aby lépe filtroval memories", sessionId),
        assistantMsg(
          "Dobře, upravím threshold filtrování v messages.transform handleru. " +
          "Změním MEMORY_MIN_SCORE z 0.45 na 0.55 pro lepší přesnost. " +
          "Tato změna zamezí injekci low-relevance memories do system promptu. " +
          "Lesson learned: vyšší threshold = méně ale relevantnější kontext.",
          sessionId,
        ),
      ]

      // Trigger session.idle
      await hooks.event?.({
        event: {
          type: "session.idle",
          properties: { info: { sessionID: sessionId } },
        } as Parameters<NonNullable<typeof hooks.event>>[0]["event"],
      })

      const sessionSummary = captured.stored.find(m => m.memory_type === "session_summary")
      if (sessionSummary) {
        console.log("\n  ✓ session_summary stored")
        console.log(`    tags: [${sessionSummary.tags.join(", ")}]`)
        console.log(`    content preview: ${sessionSummary.content.substring(0, 120)}...`)
      } else {
        console.log("\n  - session_summary NOT stored")
        console.log("    (check: SESSION_MIN_TOOLS, API availability, or inspect logs)")
      }
    },
  },

  // 4. conversation — no file edits, long enough
  {
    name: "conversation",
    description: "Conversation without file edits, long enough → saves conversation_summary",
    fn: async (hooks, sessionId) => {
      console.log(`\nSimulating: 2 tool calls (read only), long assistant response, then session.idle`)

      const toolInputBase = { sessionID: sessionId, callID: "call-1", args: {} }
      await hooks["tool.execute.after"]?.(
        { ...toolInputBase, tool: "read", callID: "call-1" } as Parameters<NonNullable<typeof hooks["tool.execute.after"]>>[0],
        { title: "Read", output: "", metadata: {} },
      )
      await hooks["tool.execute.after"]?.(
        { ...toolInputBase, tool: "bash", callID: "call-2" } as Parameters<NonNullable<typeof hooks["tool.execute.after"]>>[0],
        { title: "Bash", output: "", metadata: {} },
      )

      const longAssistantText =
        "Tady je detailní analýza fungování doobidoo pluginu a jeho dvou-fázového inject mechanismu. " +
        "Plugin nejprve zachytí messages.transform hook kde extrahuje text posledního user message. " +
        "Potom provede paralelně tři dotazy do doobidoo API: identity tagy, lessons-learned tagy a semantický search. " +
        "Výsledky jsou deduplikovány pomocí content_hash a sestaveny do memory block textu. " +
        "Tento blok je uložen do sessionState.pendingMemoryBlock pro následující system.transform. " +
        "Ve system.transform je blok appended na konec output.system[] — tím se zachová prompt caching pro system[0]. " +
        "Celý mechanismus je navržen tak aby byl transparentní pro uživatele ale přidával kritický kontext do každého LLM volání."

      scenarioMessages = [
        userMsg("Vysvětli jak funguje memory injection", sessionId),
        assistantMsg(longAssistantText, sessionId),
      ]

      await hooks.event?.({
        event: {
          type: "session.idle",
          properties: { info: { sessionID: sessionId } },
        } as Parameters<NonNullable<typeof hooks.event>>[0]["event"],
      })

      const convSummary = captured.stored.find(m => m.memory_type === "conversation_summary")
      if (convSummary) {
        console.log("\n  ✓ conversation_summary stored")
        console.log(`    tags: [${convSummary.tags.join(", ")}]`)
        console.log(`    content preview: ${convSummary.content.substring(0, 120)}...`)
      } else {
        console.log("\n  - conversation_summary NOT stored")
        console.log("    (check: assistant text length, SESSION_MIN_TOOLS, or inspect logs)")
      }
    },
  },

  // 5. short — conversation too short → skip
  {
    name: "short",
    description: "Conversation too short (< 300 chars) → nothing stored",
    fn: async (hooks, sessionId) => {
      console.log(`\nSimulating: 2 tool calls, short assistant response (<300 chars)`)

      const toolInputBase = { sessionID: sessionId, callID: "call-1", args: {} }
      await hooks["tool.execute.after"]?.(
        { ...toolInputBase, tool: "read", callID: "call-1" } as Parameters<NonNullable<typeof hooks["tool.execute.after"]>>[0],
        { title: "Read", output: "", metadata: {} },
      )
      await hooks["tool.execute.after"]?.(
        { ...toolInputBase, tool: "bash", callID: "call-2" } as Parameters<NonNullable<typeof hooks["tool.execute.after"]>>[0],
        { title: "Bash", output: "", metadata: {} },
      )

      scenarioMessages = [
        userMsg("Jak se jmenuješ?", sessionId),
        assistantMsg("Jsem OpenCode.", sessionId),  // very short
      ]

      await hooks.event?.({
        event: {
          type: "session.idle",
          properties: { info: { sessionID: sessionId } },
        } as Parameters<NonNullable<typeof hooks.event>>[0]["event"],
      })

      const hasStore = captured.stored.length > 0
      const skipLog = captured.logs.find(l => l.message.includes("too short") || l.message.includes("Skipped"))

      if (!hasStore && skipLog) {
        console.log("\n  ✓ correctly skipped (content too short)")
        console.log(`    → ${skipLog.message}`)
      } else if (hasStore) {
        console.log("\n  ✗ unexpected: memory was stored even though content is short")
      } else {
        console.log("\n  ~ nothing stored (expected), but no skip log found")
        console.log("    (check: SESSION_MIN_TOOLS threshold or API availability)")
      }
    },
  },

  // 6. inject-subagent — subagent session → skip inject
  {
    name: "inject-subagent",
    description: "Subagent session (parentID set) → skip memory inject",
    fn: async (hooks, sessionId) => {
      console.log(`\nSimulating: subagent session with parentID set`)

      // Override session.get for this scenario - return parentID to simulate subagent
      const originalGet = (fakeClient as Record<string, unknown>).session?.get
      if ((fakeClient as Record<string, unknown>).session) {
        ((fakeClient as Record<string, unknown>).session as Record<string, unknown>).get =
          async (_opts: unknown) => ({ data: { parentID: "parent-session-123" } })
      }

      scenarioMessages = [
        userMsg("do this task", sessionId),
      ]

      await hooks["experimental.chat.messages.transform"]?.(
        { sessionID: sessionId } as Parameters<NonNullable<typeof hooks["experimental.chat.messages.transform"]>>[0],
        { messages: scenarioMessages },
      )

      // Call system.transform - should detect subagent and skip
      await hooks["experimental.chat.system.transform"]?.(
        { sessionID: sessionId, model: { id: "test-model" } } as Parameters<NonNullable<typeof hooks["experimental.chat.system.transform"]>>[0],
        { system: ["You are a helpful assistant."] },
      )

      // Restore original get
      if ((fakeClient as Record<string, unknown>).session) {
        ((fakeClient as Record<string, unknown>).session as Record<string, unknown>).get = originalGet
      }

      const skipLog = captured.logs.find(l => l.message.includes("Skipping memory inject for subagent"))
      const hasInject = captured.logs.find(l => l.message.includes("[MEMORY] inject:"))

      if (skipLog && !hasInject) {
        console.log("\n  ✓ correctly skipped inject for subagent")
        console.log(`    → ${skipLog.message}`)
      } else if (hasInject) {
        console.log("\n  ✗ unexpected: memory was injected for subagent")
      } else {
        console.log("\n  ~ no skip log found (check: session.get mock)")
      }
    },
  },
]

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const toRun = scenarioFilter
  ? scenarios.filter(s => s.name === scenarioFilter)
  : scenarios

if (toRun.length === 0) {
  console.error(`Unknown scenario: "${scenarioFilter}"`)
  console.error(`Available: ${scenarios.map(s => s.name).join(", ")}`)
  process.exit(1)
}

console.log(`\nDoobidoo plugin harness — ${toRun.length} scenario(s)${dryRun ? " [DRY-RUN]" : ""}`)

for (const s of toRun) {
  await runScenario(s.name, s.description, s.fn)
}

console.log("\nDone.\n")
