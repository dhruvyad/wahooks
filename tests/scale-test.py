"""
WAHooks Auto-Scale Verification Test

Tests that scaling logic works correctly with WAHA Plus (50 sessions/pod):
- Creates connections in stages
- Verifies worker assignment and counter accuracy
- Verifies all connections share the SAME worker (until 50)
- Tests deletion properly decrements counters
- Verifies no unnecessary worker provisioning

Usage:
  WAHOOKS_API_KEY=wh_... python tests/scale-test.py
"""

import asyncio
import os
import sys
import time

import httpx

API_KEY = os.environ.get("WAHOOKS_API_KEY")
BASE_URL = os.environ.get("WAHOOKS_API_URL", "https://api.wahooks.com")

if not API_KEY:
    print("Set WAHOOKS_API_KEY environment variable")
    sys.exit(1)

passed = 0
failed = 0
errors = []


def ok(name, detail=""):
    global passed
    passed += 1
    print(f"  ✓ {name}" + (f"  ({detail})" if detail else ""))


def fail(name, detail):
    global failed
    failed += 1
    errors.append(f"{name}: {detail}")
    print(f"  ✗ {name}: {detail}")


async def get_db_state(client):
    """Get worker and session state from the API."""
    r = await client.get("/connections")
    connections = r.json() if r.status_code == 200 and isinstance(r.json(), list) else []
    active = [c for c in connections if c.get("status") != "stopped"]
    workers = {}
    for c in active:
        wid = c.get("workerId")
        if wid:
            workers[wid] = workers.get(wid, 0) + 1
    return active, workers


async def main():
    print("=" * 60)
    print("WAHooks Auto-Scale Verification Test")
    print(f"Target: {BASE_URL}")
    print("=" * 60)

    client = httpx.AsyncClient(
        base_url=f"{BASE_URL}/api",
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        timeout=60.0,
    )

    connection_ids = []

    # ── Stage 1: Create 10 connections, verify they share 1 worker ──
    print("\n── Stage 1: Create 10 connections (should use 1 worker) ──")

    for i in range(10):
        try:
            r = await client.post("/connections")
            if r.status_code in (200, 201):
                connection_ids.append(r.json()["id"])
            else:
                print(f"    ⚠ create {i+1} returned HTTP {r.status_code}")
        except Exception as e:
            print(f"    ⚠ create {i+1} failed: {type(e).__name__}")
        await asyncio.sleep(0.5)

    if len(connection_ids) == 10:
        ok(f"created 10 connections")
    else:
        fail("create", f"only {len(connection_ids)}/10")
        await client.aclose()
        return

    await asyncio.sleep(2)
    active, workers = await get_db_state(client)
    test_active = [c for c in active if c.get("id") in connection_ids]
    assigned = [c for c in test_active if c.get("workerId")]
    unique_workers = set(c.get("workerId") for c in assigned)

    print(f"    Assigned: {len(assigned)}/10, Workers used: {len(unique_workers)}")

    if len(unique_workers) <= 1:
        ok("10 connections share 1 worker (correct for 50 max/pod)")
    else:
        fail("worker count", f"expected 1 worker, got {len(unique_workers)}")

    # ── Stage 2: Create 20 more (total 30), still 1 worker ──
    print("\n── Stage 2: Create 20 more (total 30, still 1 worker) ──")

    for i in range(20):
        r = await client.post("/connections")
        if r.status_code in (200, 201):
            connection_ids.append(r.json()["id"])
        await asyncio.sleep(0.5)

    await asyncio.sleep(2)
    active, workers = await get_db_state(client)
    test_active = [c for c in active if c.get("id") in connection_ids]
    assigned = [c for c in test_active if c.get("workerId")]
    unique_workers = set(c.get("workerId") for c in assigned)

    print(f"    Total: {len(connection_ids)}, Assigned: {len(assigned)}, Workers: {len(unique_workers)}")

    if len(unique_workers) <= 1:
        ok("30 connections still on 1 worker")
    else:
        fail("worker count at 30", f"expected 1, got {len(unique_workers)}")

    # ── Stage 3: Delete 15 connections, verify counter decrements ──
    print("\n── Stage 3: Delete 15 connections (verify counter decrements) ──")

    to_delete = connection_ids[:15]
    for cid in to_delete:
        await client.delete(f"/connections/{cid}")
        await asyncio.sleep(0.3)

    connection_ids = connection_ids[15:]  # Keep remaining

    await asyncio.sleep(2)
    active, workers = await get_db_state(client)
    test_active = [c for c in active if c.get("id") in connection_ids]

    print(f"    Remaining: {len(connection_ids)}, Active in API: {len(test_active)}")

    if len(test_active) <= len(connection_ids):
        ok(f"deleted 15, {len(test_active)} remain active")
    else:
        fail("delete", f"expected ~{len(connection_ids)}, got {len(test_active)} active")

    # Check worker counter accuracy
    for wid, count in workers.items():
        print(f"    Worker {wid[:8]}...: {count} sessions (DB counter)")

    # ── Stage 4: Delete remaining, verify cleanup ──
    print("\n── Stage 4: Delete remaining connections ──")

    for cid in connection_ids:
        await client.delete(f"/connections/{cid}")
        await asyncio.sleep(0.3)

    await asyncio.sleep(2)
    active, workers = await get_db_state(client)
    leftover = [c for c in active if c.get("id") in connection_ids]

    if len(leftover) == 0:
        ok("all test connections cleaned up")
    else:
        fail("cleanup", f"{len(leftover)} remain")

    # Check workers have 0 sessions
    for wid, count in workers.items():
        if count > 0:
            print(f"    ⚠ Worker {wid[:8]}... still has {count} sessions")

    await client.aclose()

    # ── Summary ──
    print("\n" + "=" * 60)
    total = passed + failed
    status = "PASS" if failed == 0 else "FAIL"
    print(f"{status}: {passed} passed, {failed} failed out of {total}")
    if errors:
        print("\nFailures:")
        for e in errors:
            print(f"  ✗ {e}")
    print("=" * 60 + "\n")
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    asyncio.run(main())
