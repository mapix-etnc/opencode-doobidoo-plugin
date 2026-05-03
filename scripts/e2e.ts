/**
 * DoobidooMemoryPlugin — E2E test using OpenCode SDK
 *
 * Tests the full inject pipeline against a real OpenCode instance:
 *   1. Store unique test memory in doobidoo
 *   2. Start fresh OpenCode (createOpencode — loads plugin from ~/.config/opencode/plugins/)
 *   3. Create session + send targeted prompt
 *   4. Verify LLM response contains the secret word (confirms inject worked)
 *   5. Cleanup: delete test memory + session + close server
 *
 * What this covers that harness does NOT:
 *   - Plugin actually loaded and registered by OpenCode
 *   - experimental.chat.messages.transform actually called by OpenCode
 *   - experimental.chat.system.transform actually called by OpenCode
 *   - Real LLM sees the injected memory context
 *
 * Configuration (from .env or environment):
 *   DOOBIDOO_API_URL  — default: http://localhost:8000/api
 *   MEMORY_API_KEY    — required for store/delete operations
 *   E2E_MODEL         — model for test LLM call (default: llm-test/qwen3-8b)
 *
 * Usage:
 *   bun run e2e
 */

import { createOpencode } from "@opencode-ai/sdk"

// ---------------------------------------------------------------------------
// Config (Bun auto-loads .env)
// ---------------------------------------------------------------------------
declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code: number): never }

const MEMORY_API = process.env.DOOBIDOO_API_URL ?? "http://localhost:8000/api"
const MEMORY_API_KEY = process.env.MEMORY_API_KEY ?? ""
const E2E_MODEL = process.env.E2E_MODEL ?? "llm-test/qwen3-8b"

if (!MEMORY_API_KEY) {
  console.error("✗ MEMORY_API_KEY is not set — check .env file")
  process.exit(1)
}

// Parse "providerID/modelID" (handles slashes in model name like "github-copilot/claude-sonnet-4.6")
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
let sessionId: string | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  if (sessionId && server) {
    // client is in scope below — access via closure
  }
  if (server) {
    server.close()
    console.log("  → OpenCode server closed: ✓")
    server = null
  }
}

const uniqueKey = `E2E_${Date.now()}`
const secretWord = `SECRET_${randomWord()}`

console.log("\n" + hr())
console.log(" DoobidooMemoryPlugin — E2E Test")
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

// [3] Create session
console.log("\n[3] Creating session...")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionRes = await (client as any).session.create({ body: {} })
sessionId = sessionRes.data?.id ?? sessionRes.id ?? null
console.log(`  ✓ Session: ${sessionId}`)

// [4] Send prompt
const prompt = `What secret test word is stored for ${uniqueKey}? Quote it exactly as written.`
console.log(`\n[4] Sending prompt:`)
console.log(`    "${prompt}"`)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const promptRes = await (client as any).session.prompt({
  path: { id: sessionId },
  body: {
    model: { providerID, modelID },
    parts: [{ type: "text", text: prompt }],
  },
})

// [5] Verify response
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parts: Array<any> = promptRes.data?.parts ?? promptRes.parts ?? []
const responseText: string = parts
  .filter((p: { type: string }) => p.type === "text")
  .map((p: { text?: string }) => p.text ?? "")
  .join("")

console.log(`\n[5] LLM response preview:`)
console.log(`    ${responseText.substring(0, 300).replace(/\n/g, "\n    ")}`)

const passed = responseText.includes(secretWord)
console.log(`\n[6] Verification:`)
if (passed) {
  console.log(`  ✓ Secret word "${secretWord}" found in response — injection confirmed`)
} else {
  console.log(`  ✗ Secret word "${secretWord}" NOT found in response`)
  console.log(`    Possible causes:`)
  console.log(`      - Plugin hook not registered (messages.transform renamed/removed)`)
  console.log(`      - doobidoo API not reachable from plugin subprocess`)
  console.log(`      - Memory score below MEMORY_MIN_SCORE threshold`)
  console.log(`      - LLM response did not include the memory context`)
}

// [7] Cleanup
console.log("\n[7] Cleanup...")
if (contentHash) {
  const deleteRes = await fetch(`${MEMORY_API}/memories/${contentHash}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${MEMORY_API_KEY}` },
  }).catch(() => null)
  console.log(`  → Test memory deleted: ${deleteRes?.ok ? "✓" : "✗ (hash: " + contentHash + ")"}`)
}

if (sessionId) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (client as any).session.delete({ path: { id: sessionId } }).catch(() => null)
  console.log("  → Session deleted: ✓")
}

server.close()
console.log("  → OpenCode server closed: ✓")

// Result
console.log("\n" + hr())
console.log(passed ? " ✓  E2E PASSED" : " ✗  E2E FAILED")
console.log(hr() + "\n")

process.exit(passed ? 0 : 1)
