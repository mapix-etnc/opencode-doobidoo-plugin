/**
 * DoobidooMemoryPlugin — E2E test: subagent inject skip
 *
 * Tests that subagent sessions (with parentID) do NOT get memory injected.
 *
 * Steps:
 *   1. Store unique test memory in doobidoo
 *   2. Start fresh OpenCode (loads plugin from ~/.config/opencode/plugins/)
 *   3. Create parent session
 *   4. Create child session with parentID (simulates subagent)
 *   5. Send prompt to child session asking for the secret
 *   6. Verify LLM response does NOT contain the secret word (inject was skipped)
 *   7. Cleanup: delete test memory + sessions + close server
 *
 * Usage:
 *   bun run e2e-subagent
 */

import { createOpencode } from "@opencode-ai/sdk"

// ---------------------------------------------------------------------------
// Config (Bun auto-loads .env)
// ---------------------------------------------------------------------------
declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code: number): never; stdout: { write(s: string): void } }

const MEMORY_API = process.env.DOOBIDOO_API_URL ?? "http://localhost:8000/api"
const MEMORY_API_KEY = process.env.MEMORY_API_KEY ?? ""
const E2E_MODEL = process.env.E2E_MODEL ?? "llm-test/qwen3-8b"

if (!MEMORY_API_KEY) {
  console.error("✗ MEMORY_API_KEY is not set — check .env file")
  process.exit(1)
}

// Parse "providerID/modelID"
const slashIdx = E2E_MODEL.indexOf("/")
const providerID = E2E_MODEL.substring(0, slashIdx)
const modelID = E2E_MODEL.substring(slashIdx + 1)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function randomWord(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

function hr(char = "═", width = 52): string {
  return char.repeat(width)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let contentHash: string | null = null
let parentSessionId: string | null = null
let childSessionId: string | null = null
let server: any = null

async function cleanup() {
  if (contentHash) {
    const res = await fetch(`${MEMORY_API}/memories/${contentHash}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${MEMORY_API_KEY}` },
    }).catch(() => null)
    console.log(`  → Test memory deleted: ${res?.ok ? "✓" : "✗ (manual cleanup needed)"}`)
    contentHash = null
  }
  if (childSessionId && client) {
    await client.session.delete({ path: { id: childSessionId } }).catch(() => null)
    console.log("  → Child session deleted: ✓")
    childSessionId = null
  }
  if (parentSessionId && client) {
    await client.session.delete({ path: { id: parentSessionId } }).catch(() => null)
    console.log("  → Parent session deleted: ✓")
    parentSessionId = null
  }
  if (server) {
    server.close()
    console.log("  → OpenCode server closed: ✓")
    server = null
  }
}

const uniqueKey = `E2E_SUBAGENT_${Date.now()}`
const secretWord = `SECRET_${randomWord()}`

console.log("\n" + hr())
console.log(" DoobidooMemoryPlugin — E2E Test: Subagent Inject Skip")
console.log(hr())
console.log(`Model:  ${E2E_MODEL}`)
console.log(`Key:    ${uniqueKey}`)
console.log(`Secret: ${secretWord}`)
console.log(hr("-"))

// [1] Store unique test memory
console.log("\n[1] Storing test memory in doobidoo...")
const storeRes = await fetch(`${MEMORY_API}/memories`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${MEMORY_API_KEY}`,
  },
  body: JSON.stringify({
    content: `${uniqueKey}: the secret test word is ${secretWord}`,
    tags: ["e2e-test"],
    memory_type: "test",
  }),
})

if (!storeRes.ok) {
  console.error(`  ✗ Failed to store test memory: HTTP ${storeRes.status}`)
  process.exit(1)
}

const storeData = await storeRes.json() as { content_hash?: string }
contentHash = storeData.content_hash ?? null
console.log(`  ✓ Stored (hash: ${contentHash?.substring(0, 16)}...)`)

// [2] Start fresh OpenCode instance
console.log("\n[2] Starting OpenCode (loading plugin from ~/.config/opencode/plugins/)...")
console.log("    This takes ~10–20s...")

const opencode = await createOpencode({
  timeout: 30_000,
  config: {
    model: E2E_MODEL,
  },
})

server = opencode.server
const client = opencode.client
console.log(`  ✓ Server: ${server.url}`)

// [3] Create parent session
console.log("\n[3] Creating parent session...")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parentRes = await (client as any).session.create({ body: {} })
parentSessionId = parentRes.data?.id ?? parentRes.id ?? null
console.log(`  ✓ Parent session: ${parentSessionId}`)

// [4] Create child session (subagent with parentID)
console.log("\n[4] Creating child session (subagent with parentID)...")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const childRes = await (client as any).session.create({
  body: { parentID: parentSessionId },
})
childSessionId = childRes.data?.id ?? childRes.id ?? null
console.log(`  ✓ Child session: ${childSessionId}`)

// Debug: verify parentID is set
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const childInfo = await (client as any).session.get({ path: { id: childSessionId } })
console.log(`  Debug: child session parentID = ${childInfo.data?.parentID ?? "(not set)"}`)

// [5] Send prompt via prompt_async
const prompt = `What secret test word is stored for ${uniqueKey}? Quote it exactly as written.`
console.log(`\n[5] Sending prompt to child session:`)
console.log(`    "${prompt}"`)

// Subscribe SSE before sending prompt to catch all events
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resolveAssistant!: (text: string) => void
const assistantPromise = new Promise<string>(res => { resolveAssistant = res })

const sseWatcher = (async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { stream } = await (client as any).event.subscribe()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const event of stream as AsyncIterable<any>) {
    const type: string = event?.type ?? ""
    if (type === "session.error") {
      const msg = event?.properties?.error?.data?.message ?? "unknown"
      resolveAssistant(`__ERROR__: ${msg}`)
      break
    }
    if (type === "session.idle" && event?.properties?.sessionID === childSessionId) {
      // Fetch final messages
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msgsRes = await (client as any).session.messages({ path: { id: childSessionId } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msgs: Array<any> = msgsRes.data ?? []
      const assistants = msgs.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (m: any) => m.info?.role === "assistant" && !m.info?.error,
      )
      if (assistants.length > 0) {
        const last = assistants[assistants.length - 1]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = (last.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join("")
        resolveAssistant(text)
      } else {
        resolveAssistant("")
      }
      break
    }
  }
})()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
await (client as any).session.promptAsync({
  path: { id: childSessionId },
  body: {
    model: { providerID, modelID },
    parts: [{ type: "text", text: prompt }],
  },
})

console.log(`\n[5b] Waiting for assistant reply (up to 60s)...`)
const responseText = await Promise.race([
  assistantPromise,
  new Promise<string>(res => setTimeout(() => res("__TIMEOUT__"), 60_000)),
])

void sseWatcher.catch(() => {})

// [6] Verify response does NOT contain secret word
console.log(`\n[6] LLM response preview:`)
console.log(`    ${responseText.substring(0, 300).replace(/\n/g, "\n    ")}`)

const isTimeout = responseText === "__TIMEOUT__"
if (isTimeout) {
  console.log(`\n[6] Verification: ✗ TIMEOUT - LLM did not respond in time`)
  console.log(`    This is a test infrastructure issue, not a plugin bug`)
  console.log(`    Check if child session (subagent) processes prompt correctly`)
}

const incorrectlyInjected = responseText.includes(secretWord)
console.log(`\n[6] Verification:`)
if (!incorrectlyInjected) {
  console.log(`  ✓ Secret word "${secretWord}" NOT found in response — inject correctly skipped for subagent`)
} else {
  console.log(`  ✗ BUG: Secret word "${secretWord}" found in response — inject was NOT skipped!`)
}

// [7] Cleanup
console.log("\n[7] Cleanup...")
await cleanup()

// Result
console.log("\n" + hr())
if (isTimeout) {
  console.log(" ✗  E2E SUBAGENT FAILED (timeout)")
} else if (!incorrectlyInjected) {
  console.log(" ✓  E2E SUBAGENT PASSED")
} else {
  console.log(" ✗  E2E SUBAGENT FAILED")
}
console.log(hr() + "\n")

process.exit(isTimeout || incorrectlyInjected ? 1 : 0)
