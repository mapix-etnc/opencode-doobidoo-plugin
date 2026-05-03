/**
 * DoobidooMemoryPlugin for OpenCode
 *
 * Automatically injects relevant memories into the system prompt
 * and saves session summaries (lessons learned) after session completion.
 *
 * Architecture:
 *   - memory-doobidoo: MCP server (for the agent — memory_store/search tools)
 *   - mcp-memory-http.service: HTTP REST API (for this plugin — direct calls)
 *
 * Inject flow (two-phase, guaranteed ordering):
 *   1. messages.transform — extracts user prompt from messages,
 *      performs memory search, stores result in state.pendingMemoryBlock
 *   2. system.transform — reads state.pendingMemoryBlock,
 *      pushes to end of system prompt, clears state
 *   Order is guaranteed: messages.transform → system.transform → LLM call.
 *
 * Triggers:
 *   - messages.transform: memory search + state preparation
 *   - system.transform: inject into system prompt
 *   - session.idle: session completed → save session/conversation summary
 *   - experimental.session.compacting: extend compaction prompt with memory instructions
 *
 * Configuration (env vars):
 *   DOOBIDOO_API_URL    — base URL of the doobidoo REST API (default: http://localhost:8000/api)
 *   MEMORY_API_KEY      — Bearer token; falls back to reading ~/.config/opencode/secrets/memory-api-key
 *   MEMORY_MIN_SCORE    — minimum similarity score override (default: 0.55)
 *   MEMORY_INJECT_LIMIT — max semantic memories to inject override (default: 7)
 */

import type { Plugin } from "@opencode-ai/plugin"

// Bun runtime provides process globally; declare minimal interface for TypeScript
declare const process: { env: Record<string, string | undefined> }

// --- Configuration ---

const MEMORY_API = process.env.DOOBIDOO_API_URL ?? "http://localhost:8000/api"

function loadApiKey(): string {
  if (process.env.MEMORY_API_KEY) return process.env.MEMORY_API_KEY
  try {
    const home = process.env.HOME ?? "/var/home/mpx"
    // Bun.spawnSync is available in Bun runtime — synchronous file read without fs module
    const result = (globalThis as Record<string, unknown> & {
      Bun?: { spawnSync: (cmd: string[]) => { exitCode: number; stdout: { toString(): string } } }
    }).Bun?.spawnSync(["cat", `${home}/.config/opencode/secrets/memory-api-key`])
    if (result && result.exitCode === 0) return result.stdout.toString().trim()
    return ""
  } catch {
    return ""
  }
}

const MEMORY_API_KEY = loadApiKey()
const MEMORY_INJECT_LIMIT = Number(process.env.MEMORY_INJECT_LIMIT ?? "7")
const MEMORY_LESSONS_LIMIT = 5
const MEMORY_IDENTITY_LIMIT = 8
const MEMORY_RECENT_LIMIT = 5
const MEMORY_MIN_SCORE = Number(process.env.MEMORY_MIN_SCORE ?? "0.55")
const MEMORY_FALLBACK_THRESHOLD = 2   // if semantic returns fewer than this → add recent sessions
const MEMORY_PRIORITY_TAGS = ["identity", "preference"]  // always inject regardless of query
const SESSION_MIN_TOOLS = 2           // min tool calls required to save a session summary
const CONVERSATION_MIN_CHARS = 300    // min assistant text length to save a conversation summary

// --- HTTP helpers ---

type MemoryEntry = { content: string; content_hash: string; tags: string[]; memory_type?: string }
type MemoryResult = { memory: MemoryEntry; similarity_score: number }
type MemoryResultNullable = { memory: MemoryEntry; similarity_score: number | null }

async function searchMemories(query: string, nResults = MEMORY_INJECT_LIMIT) {
  try {
    const res = await fetch(`${MEMORY_API}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, n_results: nResults }),
    })
    if (!res.ok) return []
    const data = await res.json() as { results: Array<MemoryResult> }
    return (data.results || []).filter(r => r.similarity_score >= MEMORY_MIN_SCORE)
  } catch {
    return []
  }
}

async function searchMemoriesByTag(tags: string[], limit?: number) {
  try {
    const res = await fetch(`${MEMORY_API}/search/by-tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags, match_all: false }),
    })
    if (!res.ok) return []
    const data = await res.json() as { results: Array<MemoryResultNullable> }
    const results = data.results || []
    return limit ? results.slice(0, limit) : results
  } catch {
    return []
  }
}

async function getRecentSessionMemories(limit = MEMORY_RECENT_LIMIT) {
  return searchMemoriesByTag(["session"], limit)
}

async function storeMemory(content: string, tags: string[], memoryType = "observation") {
  try {
    const res = await fetch(`${MEMORY_API}/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${MEMORY_API_KEY}`,
      },
      body: JSON.stringify({ content, tags, memory_type: memoryType }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function isMemoryApiAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${MEMORY_API}/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

// --- Plugin ---

export const DoobidooMemoryPlugin: Plugin = async ({ client, directory }) => {
  // Per-session tracking state
  const sessionState = new Map<string, {
    lastInjectedQuery: string        // last query for which inject was performed (empty = never)
    toolCalls: string[]
    changedFiles: Set<string>
    lastUserMessageText: string      // text of last user prompt (for session summary)
    pendingLessonsExtraction: boolean  // flag: waiting for lessons extraction after compaction
    // Populated in messages.transform, consumed in system.transform
    pendingMemoryBlock: {
      text: string                   // ready text to inject into system prompt
      totalCount: number
      counts: { identity: number; lessons: number; context: number; recent: number }
    } | null
  }>()

  function getState(sessionId: string) {
    if (!sessionState.has(sessionId)) {
      sessionState.set(sessionId, {
        lastInjectedQuery: "",
        toolCalls: [],
        changedFiles: new Set(),
        lastUserMessageText: "",
        pendingLessonsExtraction: false,
        pendingMemoryBlock: null,
      })
    }
    return sessionState.get(sessionId)!
  }

  return {
    // -----------------------------------------------------------------------
    // 0. GENERIC EVENT HANDLER
    //    session.created, message.updated and session.idle are not in the
    //    Hooks interface as named hooks → must go through generic event handler.
    // -----------------------------------------------------------------------
    event: async ({ event }) => {
      const eventType = (event as { type: string }).type
      // sessionID is nested in event.properties.info.sessionID (not directly on event)
      const eventAny = event as {
        type: string
        sessionID?: string
        properties?: {
          sessionID?: string
          info?: { sessionID?: string }
        }
      }
      const sessionId = eventAny.properties?.info?.sessionID
        ?? eventAny.properties?.sessionID
        ?? eventAny.sessionID

      // PRE-WARM: session.created
      if (eventType === "session.created") {
        try {
          const res = await fetch(`${MEMORY_API}/health`, { signal: AbortSignal.timeout(5000) })
          await client.app.log({
            body: {
              service: "doobidoo-memory",
              level: "info",
              message: `Memory server pre-warm: ${res.ok ? "ok" : `status ${res.status}`}`,
            },
          })
        } catch {
          // Server may not be available — silently ignore
        }
        return
      }

      // SESSION SUMMARY: session.idle
      if (eventType === "session.idle") {
        if (!sessionId) return

        const state = getState(sessionId)

        // Post-compaction: extract lessons from summary
        if (state.pendingLessonsExtraction) {
          state.pendingLessonsExtraction = false

          if (await isMemoryApiAvailable()) {
            try {
              const msgs = await client.session.messages({ path: { id: sessionId } })
              const allMessages = msgs.data || []
              const date = new Date().toISOString().split("T")[0]
              let lessonsExtracted = 0

              for (const msg of allMessages) {
                const textContent = (msg.parts || [])
                  .filter((p: { type: string }) => p.type === "text")
                  .map((p) => ((p as unknown) as { text: string }).text)
                  .join("\n")

                if (textContent.includes("## LESSONS LEARNED")) {
                  const match = textContent.match(/## LESSONS LEARNED\n([\s\S]*?)(?:\n## |\n---|\n\n\n|$)/)
                  if (match) {
                    const lessons = match[1]
                      .split("\n")
                      .filter((l: string) => l.trim().startsWith("- "))
                      .map((l: string) => l.replace(/^- /, "").trim())
                      .filter((l: string) => l.length > 20)

                    for (const lesson of lessons) {
                      await storeMemory(lesson, ["lessons-learned", "compaction-extracted", date], "lessons-learned")
                      lessonsExtracted++
                    }
                  }
                  break
                }
              }

              if (lessonsExtracted > 0) {
                await client.tui.showToast({
                  body: { message: `Memory: ${lessonsExtracted} lessons extracted from compaction`, variant: "success", duration: 5000 },
                })
                await client.app.log({
                  body: {
                    service: "doobidoo-memory",
                    level: "info",
                    message: `Extracted ${lessonsExtracted} lessons from compaction for session ${sessionId}`,
                  },
                })
              }
            } catch (err) {
              await client.app.log({
                body: { service: "doobidoo-memory", level: "warn", message: `Lessons extraction failed: ${err}` },
              })
            }
          }

          sessionState.delete(sessionId)
          return
        }

        // Normal path: save session summary
        if (state.toolCalls.length < SESSION_MIN_TOOLS) {
          sessionState.delete(sessionId)
          return
        }

        if (!(await isMemoryApiAvailable())) {
          sessionState.delete(sessionId)
          return
        }

        try {
          const msgs = await client.session.messages({ path: { id: sessionId } })
          const allMessages = msgs.data || []

          const isCodeSession = state.changedFiles.size > 0

          // For conversation sessions (no file edits): only save if there is substantial content
          if (!isCodeSession) {
            const assistantPreview = allMessages
              .filter((m: { info: { role: string } }) => m.info.role === "assistant")
              .flatMap((m: { parts: Array<{ type: string; text?: string }> }) =>
                m.parts.filter((p) => p.type === "text").map((p) => p.text || "")
              )
              .join("")
            if (assistantPreview.length < CONVERSATION_MIN_CHARS) {
              await client.app.log({
                body: {
                  service: "doobidoo-memory",
                  level: "info",
                  message: `Skipped conversation summary (content too short) for ${sessionId}`,
                  extra: { tools: state.toolCalls.length, task: state.lastUserMessageText?.substring(0, 80) },
                },
              })
              sessionState.delete(sessionId)
              return
            }
          }

          // Use lastUserMessageText from messages.transform (extracted from non-synthetic parts).
          // Fallback to first user message from API (edge case when messages.transform did not run).
          const firstUserText = state.lastUserMessageText
            ? state.lastUserMessageText.substring(0, 200)
            : (() => {
                const userMsgs = allMessages.filter((m: { info: { role: string } }) => m.info.role === "user")
                return userMsgs.length > 0
                  ? (userMsgs[0].parts || [])
                      .filter((p: { type: string; synthetic?: boolean }) => p.type === "text" && !p.synthetic)
                      .map((p: { text?: string }) => p.text || "")
                      .join(" ").trim().substring(0, 200)
                  : ""
              })()

          const assistantTexts = allMessages
            .filter((m: { info: { role: string } }) => m.info.role === "assistant")
            .flatMap((m: { parts: Array<{ type: string; text?: string }> }) =>
              m.parts.filter((p) => p.type === "text").map((p) => p.text || "")
            )
            .filter((t: string) => t.length > 50)
            .slice(-3)
            .join("\n\n")

          const date = new Date().toISOString().split("T")[0]
          const workDir = directory || "unknown"
          const toolSummary = [...new Set(state.toolCalls)].join(", ")

          const summary = [
            `Session summary (${date}):`,
            `Working directory: ${workDir}`,
            firstUserText ? `Initial task: ${firstUserText}` : "",
            `Tools used: ${toolSummary}`,
            isCodeSession ? `Files changed: ${Array.from(state.changedFiles).join(", ")}` : "",
            assistantTexts ? `\nWork done:\n${assistantTexts.substring(0, 800)}` : "",
          ].filter(Boolean).join("\n")

          const hasLessons = /lesson|gotcha|workaround|zjistil|pozor|upozorn/i.test(assistantTexts)
          const tags = ["session", date]
          if (hasLessons) tags.push("lessons-learned")
          if (isCodeSession) {
            tags.push("files-changed")
          } else {
            tags.push("conversation")
          }
          if (state.toolCalls.includes("bash")) tags.push("bash")

          const memoryType = isCodeSession ? "session_summary" : "conversation_summary"
          const saved = await storeMemory(summary, tags, memoryType)

          if (saved) {
            await client.tui.showToast({
              body: { message: `Memory: ${isCodeSession ? "session" : "conversation"} summary saved (${state.toolCalls.length} tool calls)`, variant: "success", duration: 5000 },
            })
            await client.app.log({
              body: {
                service: "doobidoo-memory",
                level: "info",
                message: `Session summary saved for ${sessionId}`,
                extra: { tools: state.toolCalls.length, files: state.changedFiles.size, type: memoryType },
              },
            })
          }
        } catch (err) {
          await client.app.log({ body: { service: "doobidoo-memory", level: "warn", message: `Session summary save failed: ${err}` } })
        }

        sessionState.delete(sessionId)
      }
    },

    // -----------------------------------------------------------------------
    // 1. TRACK TOOL CALLS: for session summary
    // -----------------------------------------------------------------------
    "tool.execute.after": async (input, _output) => {
      const sessionId = (input as { sessionID?: string }).sessionID
      if (!sessionId) return

      const state = getState(sessionId)
      const toolName = (input as { tool?: string }).tool || "unknown"
      state.toolCalls.push(toolName)

      // Track changed files — args are in input (not output) per TypeScript definition
      if (toolName === "write" || toolName === "edit") {
        const filePath = ((input as Record<string, unknown>)?.args as Record<string, string>)?.filePath || ""
        if (filePath) state.changedFiles.add(filePath)
      }
    },

    // -----------------------------------------------------------------------
    // 2. MEMORY SEARCH: messages.transform
    //    Extracts user prompt directly from messages (has access to them!),
    //    performs memory search, builds memory block and stores in state.
    //    Called in prompt.ts BEFORE system.transform (llm.ts).
    // -----------------------------------------------------------------------
    "experimental.chat.messages.transform": async (_input, output) => {
      // Extract sessionID from first message
      const firstMsg = output.messages[0]
      const sessionId = (firstMsg?.info as { sessionID?: string })?.sessionID
      if (!sessionId) return

      const state = getState(sessionId)

      // Extract text of last user prompt directly from messages.
      // Note: beads plugin injects synthetic parts as a separate "user" message at the end —
      // we must find the last user message with NON-SYNTHETIC text (actual user prompt).
      const userMsgs = output.messages.filter(m => (m.info as { role: string }).role === "user")

      if (userMsgs.length === 0) return

      // Search from end — last user message with non-empty non-synthetic text
      let msgText = ""
      for (let i = userMsgs.length - 1; i >= 0; i--) {
        const msg = userMsgs[i]
        const allParts = (msg.parts || []) as Array<{ type: string; synthetic?: boolean; text?: string }>
        const nonSyntheticText = allParts
          .filter(p => p.type === "text" && !p.synthetic)
          .map(p => p.text || "")
          .join(" ")
          .trim()
        if (nonSyntheticText.length > 0) {
          msgText = nonSyntheticText
          break
        }
      }

      // Save for session summary
      if (msgText) state.lastUserMessageText = msgText

      // Empty msgText: no user text to search → clear pending and exit
      if (!msgText) {
        state.pendingMemoryBlock = null
        return
      }

      // Double-search guard: skip if query unchanged since last inject
      if (state.lastInjectedQuery === msgText) {
        state.pendingMemoryBlock = null  // system.transform will skip
        return
      }

      // Memory search
      if (!(await isMemoryApiAvailable())) return

      const hasSearchQuery = msgText.trim().length >= 10

      const [tagMemories, rawSemantic, lessonsMemories] = await Promise.all([
        searchMemoriesByTag(MEMORY_PRIORITY_TAGS, MEMORY_IDENTITY_LIMIT),
        hasSearchQuery ? searchMemories(msgText, MEMORY_INJECT_LIMIT) : Promise.resolve([]),
        searchMemoriesByTag(["lessons-learned"], MEMORY_LESSONS_LIMIT),
      ])

      const isSessionSummary = (m: MemoryResultNullable | MemoryResult) =>
        m.memory.memory_type === "session_summary" ||
        m.memory.content.startsWith("Session summary")

      const semanticMemories = rawSemantic.filter(m => !isSessionSummary(m))
      const lessonsFiltered = lessonsMemories.filter(m => !isSessionSummary(m))

      const knownHashes = new Set(tagMemories.map(m => m.memory.content_hash))
      const uniqueLessons = lessonsFiltered.filter(m => {
        if (knownHashes.has(m.memory.content_hash)) return false
        knownHashes.add(m.memory.content_hash)
        return true
      })
      const uniqueSemantic = semanticMemories.filter(m => {
        if (knownHashes.has(m.memory.content_hash)) return false
        knownHashes.add(m.memory.content_hash)
        return true
      })

      const needsFallback = uniqueSemantic.length < MEMORY_FALLBACK_THRESHOLD
      const recentSessions = needsFallback
        ? (await getRecentSessionMemories()).filter(m => !knownHashes.has(m.memory.content_hash))
        : []

      const counts = {
        identity: tagMemories.length,
        lessons: uniqueLessons.length,
        context: uniqueSemantic.length,
        recent: recentSessions.length,
      }
      const totalCount = counts.identity + counts.lessons + counts.context + counts.recent
      if (totalCount === 0) {
        state.pendingMemoryBlock = null
        return
      }

      // --- Build memory block text ---
      const sections: string[] = []

      sections.push(`## Workspace Memory

The following <memory-context> block contains AUTHORITATIVE information about this user,
their workspace, tools, and prior sessions. This data comes from a persistent memory database.

**OVERRIDE RULE:** When <memory-context> defines a term, entity, or concept,
you MUST use that definition as your answer — even if your training data suggests something different.
Do NOT fall back to general knowledge for anything covered by <memory-context>.`)

      const factParts: string[] = []
      if (tagMemories.length > 0) {
        factParts.push(`### Identity & Preferences\n${tagMemories.map(m => `- ${m.memory.content}`).join("\n")}`)
      }
      if (uniqueLessons.length > 0) {
        factParts.push(`### Lessons Learned\n${uniqueLessons.map((m, i) => `${i + 1}. ${m.memory.content}`).join("\n")}`)
      }
      if (uniqueSemantic.length > 0) {
        factParts.push(`### Related Context\n${uniqueSemantic.map((m, i) => `${i + 1}. [score: ${m.similarity_score?.toFixed(2) ?? "?"}] ${m.memory.content}`).join("\n")}`)
      }
      if (recentSessions.length > 0) {
        factParts.push(`### Recent Sessions\n${recentSessions.map((m, i) => `${i + 1}. ${m.memory.content}`).join("\n")}`)
      }

      sections.push(`<memory-context>\n${factParts.join("\n\n")}\n</memory-context>`)

      state.pendingMemoryBlock = {
        text: sections.join("\n\n"),
        totalCount,
        counts,
      }

      // Update last injected query (double-search guard)
      state.lastInjectedQuery = msgText

      const previewFn = (mems: Array<{ memory: { content: string } }>) =>
        JSON.stringify(mems.map(m => m.memory.content.substring(0, 60).replace(/\n/g, " ")))

      await client.app.log({
        body: {
          service: "doobidoo-memory",
          level: "info",
          message: `[MEMORY] search done: session=${sessionId} total=${totalCount} (id=${counts.identity} les=${counts.lessons} ctx=${counts.context} rec=${counts.recent}) query="${msgText.substring(0, 60)}"\n  ${previewFn(tagMemories)}\n  ${previewFn(uniqueSemantic)}`,
        },
      })
    },

    // -----------------------------------------------------------------------
    // 3. INJECT MEMORIES: system prompt transform
    //    Reads pendingMemoryBlock from state (populated in messages.transform),
    //    pushes to end of system prompt. Order is guaranteed.
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (input, output) => {
      const sessionId = (input as { sessionID?: string }).sessionID
      const modelId = (input as { model?: { id?: string } }).model?.id ?? "unknown"

      if (!sessionId) return

      // Skip internal LLM calls (title-generator etc.)
      const MIN_CHAT_SYSTEM_CHARS = 10_000
      const systemTotalChars = output.system.join("").length
      if (systemTotalChars < MIN_CHAT_SYSTEM_CHARS) return

      const state = sessionState.get(sessionId)
      if (!state?.pendingMemoryBlock) return

      const pending = state.pendingMemoryBlock
      state.pendingMemoryBlock = null  // consumed

      // Push to end of system prompt (preserves prompt caching — system[0] unchanged)
      output.system.push(pending.text)

      // Toast + log
      const c = pending.counts
      const modeSuffix = c.recent > 0 ? " [+recent fallback]" : ""
      await client.tui.showToast({
        body: { message: `Memory: ${pending.totalCount} injected (${c.identity}id ${c.lessons}les ${c.context}ctx ${c.recent}rec)${modeSuffix}`, variant: "success", duration: 5000 },
      })
      await client.app.log({
        body: {
          service: "doobidoo-memory",
          level: "info",
          message: `[MEMORY] inject: session=${sessionId} model=${modelId} total=${pending.totalCount} (id=${c.identity} les=${c.lessons} ctx=${c.context} rec=${c.recent})`,
        },
      })
    },

    // -----------------------------------------------------------------------
    // 4. COMPACTION HOOK: sets flag for lessons extraction + adds
    //    instructions for LESSONS LEARNED section in summary text
    // -----------------------------------------------------------------------
    "experimental.session.compacting": async (input, output) => {
      const sessionId = (input as { sessionID?: string }).sessionID
      const state = sessionId ? getState(sessionId) : null

      // 1. Set flag for lessons extraction after compaction in session.idle
      if (state) {
        state.pendingLessonsExtraction = true
      }

      // 2. Modify compaction prompt — PROHIBIT ALL tool calls (unavailable during compaction!)
      //    Instead ask AI for ## LESSONS LEARNED section in plain text
      output.context.push(`## Memory Instructions

When creating this continuation summary, identify key lessons learned and include them in a dedicated section.

Include this EXACT section at the END of your summary:

## LESSONS LEARNED
- Lesson text (pattern: "Expected X, found Y → next time do Z")
- Another lesson...

Examples of good lessons:
- "ShellCheck: on Fedora 43 toolbox the package is 'ShellCheck' (capital S), not 'shellcheck'"
- "User preference: always commit after each logical step of changes"
- "mcp-memory-http.service: needs 'env MCP_ALLOW_ANONYMOUS_ACCESS=true' in ExecStart"

CRITICAL: Do NOT call ANY tools whatsoever - NO Read, Bash, Glob, Write, Edit, nor any MCP tools (memory_store, memory_search, etc.). NONE of these tools are available during compaction. Calling any tool will result in an error. Summarize ONLY from the text already present in the conversation. All lessons must be written as plain text in the ## LESSONS LEARNED section above. The plugin will automatically extract and save them to memory after compaction completes.`)
    },
  }
}
