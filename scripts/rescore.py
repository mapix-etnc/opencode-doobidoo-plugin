#!/usr/bin/env python3
"""
Batch quality rescoring for mcp-memory-service memories using MS-MARCO model.

Strategy:
  1. Use the most recent query from metadata.access_queries (real historical context)
  2. Fallback: template query selected by tags/content category

Run after switching quality scoring model to MS-MARCO single-model mode.
Safe to re-run — idempotent, overwrites existing scores.

Usage:
  python3 scripts/rescore.py [--dry-run] [--concurrency N] [--base-url URL]
"""
import argparse
import json
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib import request as urllib_request
from urllib.error import URLError

# ── Configuration ────────────────────────────────────────────────────────────

DEFAULT_BASE_URL  = "http://127.0.0.1:8000"
DEFAULT_PAGE_SIZE = 50
DEFAULT_CONCURRENCY = 2   # safe for local ONNX single-model (OOM risk at > 2)

# Template queries (fallback when access_queries is empty)
TEMPLATE_QUERIES: dict[str, str] = {
    "session": (
        "AI assistant session summary working directory task completion "
        "tools used lessons learned"
    ),
    "lesson": (
        "lesson learned technical problem expected found workaround "
        "solution bug fix gotcha"
    ),
    "config": (
        "software configuration installation setup troubleshooting "
        "environment variables system"
    ),
    "general": (
        "technical knowledge tool usage command workflow configuration "
        "project development"
    ),
}

print_lock = threading.Lock()


# ── Query selection ───────────────────────────────────────────────────────────

def pick_query_from_access(memory: dict) -> str | None:
    """Return the most recent query from access_queries, or None if empty."""
    aq = memory.get("access_queries") or []
    if not aq:
        return None
    # Sort by timestamp descending, take first
    try:
        latest = max(aq, key=lambda x: x.get("timestamp", 0))
        q = latest.get("query", "").strip()
        # Trim very long queries (MS-MARCO cross-encoder has token limit ~512)
        # Keep first 400 chars — enough context without truncation artifacts
        return q[:400] if q else None
    except (TypeError, ValueError):
        return None


def pick_template_query(memory: dict) -> tuple[str, str]:
    """Return (category, template_query) based on tags and content."""
    tags    = [t.lower() for t in (memory.get("tags") or [])]
    content = (memory.get("content") or "").lower()

    if "session" in tags:
        return "session", TEMPLATE_QUERIES["session"]

    if any(t in tags for t in ("lessons-learned", "compaction-extracted", "lessons_learned")):
        return "lesson", TEMPLATE_QUERIES["lesson"]

    if content.startswith('"expected') or (
        "expected" in content[:80] and "found" in content[:150]
    ):
        return "lesson", TEMPLATE_QUERIES["lesson"]

    if any(t in tags for t in (
        "systemd", "mcp-memory-service", "install", "config",
        "changelog", "setup", "environment",
    )):
        return "config", TEMPLATE_QUERIES["config"]

    if any(kw in content[:200] for kw in (
        "install", "config", "setup", "systemd",
        "environment", "pip ", "dnf ", "nastavení",
    )):
        return "config", TEMPLATE_QUERIES["config"]

    return "general", TEMPLATE_QUERIES["general"]


def pick_query(memory: dict) -> tuple[str, str]:
    """
    Return (source, query_string).
    source: 'access_query' | 'template:<category>'
    """
    q = pick_query_from_access(memory)
    if q:
        return "access_query", q
    cat, tq = pick_template_query(memory)
    return f"template:{cat}", tq


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def get_all_memories(base_url: str, page_size: int) -> list[dict]:
    memories: list[dict] = []
    page = 1
    while True:
        url = f"{base_url}/api/memories?page={page}&page_size={page_size}"
        with urllib_request.urlopen(url, timeout=15) as r:
            data = json.loads(r.read().decode())
        batch = data.get("memories", [])
        memories.extend(batch)
        if not data.get("has_more", False):
            break
        page += 1
    return memories


def evaluate_one(
    memory: dict,
    idx: int,
    total: int,
    source: str,
    query: str,
    base_url: str,
    dry_run: bool,
) -> dict:
    content_hash = memory["content_hash"]

    if dry_run:
        return {
            "hash": content_hash,
            "source": source,
            "query_preview": query[:60],
            "ok": True,
            "dry_run": True,
        }

    url     = f"{base_url}/api/quality/memories/{content_hash}/evaluate"
    payload = json.dumps({"query": query}).encode()
    req     = urllib_request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read().decode())
        score    = d.get("quality_score", -1)
        provider = d.get("quality_provider", "?")
        if idx % 100 == 0 or idx <= 3:
            with print_lock:
                print(
                    f"  [{idx}/{total}] {content_hash[:8]} "
                    f"src={source} score={score:.4f} ({provider})"
                )
        return {
            "hash": content_hash, "score": score, "provider": provider,
            "source": source, "ok": True,
        }
    except (URLError, Exception) as e:
        with print_lock:
            print(f"  [{idx}/{total}] ERROR {content_hash[:8]}: {e}")
        return {"hash": content_hash, "ok": False, "error": str(e)}


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Batch MS-MARCO rescore for doobidoo memories")
    parser.add_argument("--dry-run",     action="store_true", help="Show plan without calling API")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    parser.add_argument("--base-url",    default=DEFAULT_BASE_URL)
    parser.add_argument("--page-size",   type=int, default=DEFAULT_PAGE_SIZE)
    args = parser.parse_args()

    if args.dry_run:
        print("[DRY RUN] No API calls will be made.")

    start = time.time()

    print(f"Fetching memories from {args.base_url} ...")
    try:
        memories = get_all_memories(args.base_url, args.page_size)
    except Exception as e:
        print(f"ERROR: Cannot reach memory server: {e}", file=sys.stderr)
        sys.exit(1)

    total = len(memories)
    print(f"Total memories: {total}")

    # Build assignment list
    assignments = [pick_query(m) for m in memories]

    # Stats on query source
    src_counts: dict[str, int] = {}
    for src, _ in assignments:
        src_counts[src] = src_counts.get(src, 0) + 1
    print("Query sources:")
    for k, v in sorted(src_counts.items()):
        print(f"  {k}: {v}")

    if args.dry_run:
        print("\nDry-run complete. No API calls made.")
        return

    print(f"\nStarting rescore (concurrency={args.concurrency}) ...")

    args_list = [
        (memories[i], i + 1, total, assignments[i][0], assignments[i][1],
         args.base_url, args.dry_run)
        for i in range(total)
    ]

    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures = {executor.submit(evaluate_one, *a): a for a in args_list}
        done = 0
        for future in as_completed(futures):
            results.append(future.result())
            done += 1
            if done % 50 == 0:
                elapsed = time.time() - start
                remaining = (elapsed / done) * (total - done)
                print(f"  Progress: {done}/{total}  ~{remaining:.0f}s remaining")

    elapsed = time.time() - start
    ok      = sum(1 for r in results if r.get("ok"))
    failed  = total - ok
    scores  = [r["score"] for r in results if r.get("ok") and r.get("score", -1) >= 0]

    providers: dict[str, int] = {}
    for r in results:
        if r.get("ok"):
            p = r.get("provider", "unknown")
            providers[p] = providers.get(p, 0) + 1

    high   = sum(1 for s in scores if s >= 0.7)
    medium = sum(1 for s in scores if 0.5 <= s < 0.7)
    low    = sum(1 for s in scores if s < 0.5)

    print(f"\n{'='*55}")
    print(f"Done in {elapsed:.1f}s")
    print(f"  OK:               {ok}/{total}")
    print(f"  Failed:           {failed}")
    if scores:
        print(f"  Avg score:        {sum(scores)/len(scores):.4f}")
        print(f"  Min / Max:        {min(scores):.4f} / {max(scores):.4f}")
        print(f"  High  (≥0.7):     {high}")
        print(f"  Medium (0.5-0.7): {medium}")
        print(f"  Low   (<0.5):     {low}")
    print(f"  Providers:        {providers}")
    print(f"  Query sources:    {src_counts}")


if __name__ == "__main__":
    main()
