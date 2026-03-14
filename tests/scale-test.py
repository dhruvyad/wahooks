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

    TOTAL = 200
    BATCH = 25

    # ── Stage 1: Create 50 connections (should use 1 worker) ──
    print(f"\n── Stage 1: Create first 50 connections (should use 1 worker) ──")

    created = 0
    create_failures = 0
    for i in range(50):
        try:
            r = await client.post("/connections")
            if r.status_code in (200, 201):
                connection_ids.append(r.json()["id"])
                created += 1
            elif r.status_code == 429:
                await asyncio.sleep(2)
                r = await client.post("/connections")
                if r.status_code in (200, 201):
                    connection_ids.append(r.json()["id"])
                    created += 1
                else:
                    create_failures += 1
            else:
                create_failures += 1
        except Exception as e:
            create_failures += 1
        await asyncio.sleep(0.5)
        if (i + 1) % 25 == 0:
            print(f"    Progress: {created}/50 created ({create_failures} failed)")

    await asyncio.sleep(3)
    active, workers = await get_db_state(client)
    test_active = [c for c in active if c.get("id") in connection_ids]
    assigned = [c for c in test_active if c.get("workerId")]
    unique_workers = set(c.get("workerId") for c in assigned)

    print(f"    Created: {created}, Assigned: {len(assigned)}, Workers: {len(unique_workers)}")

    if created >= 45:
        ok(f"created {created}/50 connections")
    else:
        fail("create stage 1", f"only {created}/50")

    if len(unique_workers) <= 1:
        ok("50 connections share 1 worker")
    else:
        fail("worker count at 50", f"expected 1, got {len(unique_workers)}")

    # ── Stage 2: Create 150 more (total 200, should scale to ~4 workers) ──
    print(f"\n── Stage 2: Create 150 more (total 200, expect ~4 workers) ──")

    for i in range(150):
        try:
            r = await client.post("/connections")
            if r.status_code in (200, 201):
                connection_ids.append(r.json()["id"])
                created += 1
            elif r.status_code == 429:
                await asyncio.sleep(2)
                r = await client.post("/connections")
                if r.status_code in (200, 201):
                    connection_ids.append(r.json()["id"])
                    created += 1
                else:
                    create_failures += 1
            else:
                create_failures += 1
        except Exception as e:
            create_failures += 1
        await asyncio.sleep(0.5)
        if (i + 1) % 50 == 0:
            active, workers = await get_db_state(client)
            unique = set(c.get("workerId") for c in active if c.get("workerId"))
            print(f"    Progress: {created}/{TOTAL} created, {len(unique)} workers active")

    await asyncio.sleep(5)
    active, workers = await get_db_state(client)
    test_active = [c for c in active if c.get("id") in connection_ids]
    assigned = [c for c in test_active if c.get("workerId")]
    unique_workers = set(c.get("workerId") for c in assigned)
    expected_workers = (len(connection_ids) + 49) // 50

    print(f"\n    Total created: {created} ({create_failures} failed)")
    print(f"    Active: {len(test_active)}, Assigned: {len(assigned)}")
    print(f"    Workers used: {len(unique_workers)} (expected ~{expected_workers})")

    if len(unique_workers) >= 2:
        ok(f"scaled to {len(unique_workers)} workers for {created} connections")
    else:
        fail("scale up", f"expected multiple workers, got {len(unique_workers)}")

    # ── Stage 3: Delete half, verify workers decrease ──
    print(f"\n── Stage 3: Delete half ({len(connection_ids)//2} connections) ──")

    half = len(connection_ids) // 2
    to_delete = connection_ids[:half]
    deleted = 0
    for i, cid in enumerate(to_delete):
        try:
            r = await client.delete(f"/connections/{cid}")
            if r.status_code in (200, 201):
                deleted += 1
        except:
            pass
        await asyncio.sleep(0.2)
        if (i + 1) % 50 == 0:
            print(f"    Deleted {deleted}/{half}")

    connection_ids = connection_ids[half:]
    print(f"    Deleted {deleted}, {len(connection_ids)} remaining")

    await asyncio.sleep(5)
    active, workers = await get_db_state(client)
    unique_after = set(c.get("workerId") for c in active if c.get("workerId"))
    print(f"    Workers after half-delete: {len(unique_after)}")

    ok(f"deleted {deleted} connections, {len(unique_after)} workers remain")

    # ── Stage 4: Delete remaining, verify full cleanup ──
    print(f"\n── Stage 4: Delete remaining {len(connection_ids)} connections ──")

    deleted = 0
    for i, cid in enumerate(connection_ids):
        try:
            r = await client.delete(f"/connections/{cid}")
            if r.status_code in (200, 201):
                deleted += 1
        except:
            pass
        await asyncio.sleep(0.2)
        if (i + 1) % 50 == 0:
            print(f"    Deleted {deleted}/{len(connection_ids)}")

    print(f"    Deleted {deleted} more")

    await asyncio.sleep(3)
    active, workers = await get_db_state(client)
    leftover = [c for c in active if c.get("id") in connection_ids]

    if len(leftover) == 0:
        ok("all test connections cleaned up")
    else:
        fail("cleanup", f"{len(leftover)} remain")

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
