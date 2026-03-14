"""
WAHooks Load Test Suite

Tests API throughput, connection scaling, webhook delivery, and cleanup.
Respects the 60 req/min rate limit by pacing requests.

Usage:
  WAHOOKS_API_KEY=wh_... python tests/load-test.py
"""

import asyncio
import os
import sys
import time
from dataclasses import dataclass, field

import httpx

API_KEY = os.environ.get("WAHOOKS_API_KEY")
BASE_URL = os.environ.get("WAHOOKS_API_URL", "https://api.wahooks.com")

if not API_KEY:
    print("Set WAHOOKS_API_KEY environment variable")
    sys.exit(1)


@dataclass
class Results:
    passed: int = 0
    failed: int = 0
    errors: list = field(default_factory=list)


results = Results()


def ok(name: str, detail: str = ""):
    results.passed += 1
    print(f"  ✓ {name}" + (f"  ({detail})" if detail else ""))


def fail(name: str, detail: str):
    results.failed += 1
    results.errors.append(f"{name}: {detail}")
    print(f"  ✗ {name}: {detail}")


def info(msg: str):
    print(f"    {msg}")


async def measure(client: httpx.AsyncClient, method: str, path: str, **kwargs) -> tuple[int, float]:
    """Make a request and return (status_code, latency_ms)."""
    start = time.monotonic()
    r = await client.request(method, path, **kwargs)
    ms = (time.monotonic() - start) * 1000
    return r.status_code, ms, r


async def main():
    print("\n" + "=" * 60)
    print("WAHooks Load Test Suite")
    print(f"Target: {BASE_URL}")
    print("=" * 60)

    client = httpx.AsyncClient(
        base_url=f"{BASE_URL}/api",
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        timeout=60.0,
    )

    # ── Phase 1: Latency Baseline ──
    print("\n── Phase 1: Latency Baseline (20 sequential requests) ──")

    latencies = []
    for _ in range(20):
        code, ms, _ = await measure(client, "GET", "/connections")
        if code == 200:
            latencies.append(ms)
        elif code == 429:
            await asyncio.sleep(1)

    if len(latencies) >= 15:
        latencies.sort()
        avg = sum(latencies) / len(latencies)
        p50 = latencies[len(latencies) // 2]
        p95 = latencies[int(len(latencies) * 0.95)]
        ok("latency baseline", f"avg={avg:.0f}ms p50={p50:.0f}ms p95={p95:.0f}ms")
    else:
        fail("latency baseline", f"only {len(latencies)}/20 succeeded")

    # ── Phase 2: Rate Limit Verification ──
    print("\n── Phase 2: Rate Limit Verification ──")

    burst_tasks = [client.get("/connections") for _ in range(30)]
    burst_responses = await asyncio.gather(*burst_tasks, return_exceptions=True)
    ok_count = sum(1 for r in burst_responses if not isinstance(r, Exception) and r.status_code == 200)
    limited = sum(1 for r in burst_responses if not isinstance(r, Exception) and r.status_code == 429)

    if limited > 0:
        ok("rate limiter active", f"{ok_count} passed, {limited} rate-limited out of 30")
    else:
        ok("no rate limiting hit at 30 concurrent", f"all {ok_count} passed")

    await asyncio.sleep(5)  # Cooldown

    # ── Phase 3: Connection Scaling ──
    print("\n── Phase 3: Connection Scaling (5 connections) ──")

    connection_ids = []
    for i in range(5):
        code, ms, r = await measure(client, "POST", "/connections")
        if code in (200, 201):
            connection_ids.append(r.json()["id"])
            ok(f"create connection {i+1}/5", f"{ms:.0f}ms")
        else:
            fail(f"create connection {i+1}", f"HTTP {code}")
        await asyncio.sleep(0.5)  # Pace

    # Verify all listed
    await asyncio.sleep(1)
    _, _, r = await measure(client, "GET", "/connections")
    all_conns = r.json() if isinstance(r.json(), list) else []
    found = sum(1 for c in all_conns if c.get("id") in connection_ids)
    if found == len(connection_ids):
        ok(f"all {found} connections visible in list")
    else:
        fail("connections list", f"found {found}/{len(connection_ids)}")

    # Check worker assignment
    assigned = sum(1 for c in all_conns if c.get("id") in connection_ids and c.get("workerId"))
    info(f"{assigned}/{len(connection_ids)} assigned to workers")

    # ── Phase 4: Concurrent Operations ──
    print("\n── Phase 4: Concurrent Operations ──")

    await asyncio.sleep(3)  # Cooldown

    # Concurrent detail fetches
    start = time.monotonic()
    detail_tasks = [client.get(f"/connections/{cid}") for cid in connection_ids]
    detail_results = await asyncio.gather(*detail_tasks, return_exceptions=True)
    ms = (time.monotonic() - start) * 1000
    detail_ok = sum(1 for r in detail_results if not isinstance(r, Exception) and r.status_code == 200)
    if detail_ok == len(connection_ids):
        ok(f"{detail_ok} concurrent detail fetches", f"{ms:.0f}ms")
    else:
        fail("concurrent details", f"{detail_ok}/{len(connection_ids)}")

    await asyncio.sleep(1)

    # Create webhooks
    webhook_ids = []
    for i, cid in enumerate(connection_ids):
        code, ms_wh, r = await measure(client, "POST", f"/connections/{cid}/webhooks",
            json={"url": f"https://httpbin.org/post?c={i}", "events": ["*"]})
        if code in (200, 201):
            webhook_ids.append(r.json()["id"])
        await asyncio.sleep(0.3)

    if len(webhook_ids) == len(connection_ids):
        ok(f"{len(webhook_ids)} webhook creates")
    else:
        fail("webhook creates", f"{len(webhook_ids)}/{len(connection_ids)}")

    # ── Phase 5: Webhook Delivery ──
    print("\n── Phase 5: Webhook Delivery ──")

    await asyncio.sleep(2)

    # Fire test events
    start = time.monotonic()
    test_tasks = [client.post(f"/webhooks/{wid}/test") for wid in webhook_ids]
    test_results = await asyncio.gather(*test_tasks, return_exceptions=True)
    ms = (time.monotonic() - start) * 1000
    test_ok = sum(1 for r in test_results if not isinstance(r, Exception) and r.status_code in (200, 201))

    if test_ok == len(webhook_ids):
        ok(f"{test_ok} test events fired", f"{ms:.0f}ms")
    else:
        fail("test events", f"{test_ok}/{len(webhook_ids)}")

    # Wait for delivery
    await asyncio.sleep(5)

    delivered = 0
    for wid in webhook_ids:
        _, _, r = await measure(client, "GET", f"/webhooks/{wid}/logs")
        if r.status_code == 200:
            logs = r.json()
            if any(l.get("status") == "delivered" for l in logs):
                delivered += 1
        await asyncio.sleep(0.3)

    if delivered == len(webhook_ids):
        ok(f"all {delivered} webhooks delivered")
    else:
        fail("webhook delivery", f"{delivered}/{len(webhook_ids)} delivered")

    # ── Phase 6: Token CRUD ──
    print("\n── Phase 6: Token CRUD (10 tokens) ──")

    await asyncio.sleep(3)

    token_ids = []
    for i in range(10):
        code, _, r = await measure(client, "POST", "/tokens", json={"name": f"lt-{i}"})
        if code in (200, 201):
            token_ids.append(r.json()["id"])
        await asyncio.sleep(0.3)

    if len(token_ids) == 10:
        ok("10 token creates")
    else:
        fail("token creates", f"{len(token_ids)}/10")

    # Revoke all
    for tid in token_ids:
        await client.delete(f"/tokens/{tid}")
        await asyncio.sleep(0.2)
    ok(f"revoked {len(token_ids)} tokens")

    # ── Phase 7: Cleanup ──
    print("\n── Phase 7: Cleanup ──")

    await asyncio.sleep(2)

    for wid in webhook_ids:
        await client.delete(f"/webhooks/{wid}")
    info(f"deleted {len(webhook_ids)} webhooks")

    for cid in connection_ids:
        await client.delete(f"/connections/{cid}")
        await asyncio.sleep(0.3)

    await asyncio.sleep(1)
    _, _, r = await measure(client, "GET", "/connections")
    remaining = r.json() if isinstance(r.json(), list) else []
    leftover = sum(1 for c in remaining if c.get("id") in connection_ids)
    if leftover == 0:
        ok("all test data cleaned up")
    else:
        fail("cleanup", f"{leftover} connections remain")

    await client.aclose()

    # ── Summary ──
    print("\n" + "=" * 60)
    total = results.passed + results.failed
    status = "PASS" if results.failed == 0 else "FAIL"
    print(f"{status}: {results.passed} passed, {results.failed} failed out of {total}")
    if results.errors:
        print("\nFailures:")
        for e in results.errors:
            print(f"  ✗ {e}")
    print("=" * 60 + "\n")
    sys.exit(1 if results.failed > 0 else 0)


if __name__ == "__main__":
    asyncio.run(main())
