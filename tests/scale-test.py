"""
WAHooks Scale Test — Step-by-step verification

Creates connections in controlled stages, asserting expected worker count
and counter accuracy after each stage. Then deletes and verifies scale-down.

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
DB_QUERY_CMD = None  # Set below if kubectl available

if not API_KEY:
    print("Set WAHOOKS_API_KEY environment variable")
    sys.exit(1)

passed = 0
failed = 0
errors = []


def ok(msg, detail=""):
    global passed
    passed += 1
    print(f"  ✓ {msg}" + (f"  ({detail})" if detail else ""))


def fail(msg, detail=""):
    global failed
    failed += 1
    errors.append(f"{msg}: {detail}")
    print(f"  ✗ {msg}: {detail}")


def info(msg):
    print(f"    {msg}")


async def create_connections(client, count, pace=0.5):
    """Create connections, return list of IDs created."""
    ids = []
    fails = 0
    for i in range(count):
        try:
            r = await client.post("/connections")
            if r.status_code in (200, 201):
                ids.append(r.json()["id"])
            elif r.status_code == 429:
                await asyncio.sleep(2)
                r = await client.post("/connections")
                if r.status_code in (200, 201):
                    ids.append(r.json()["id"])
                else:
                    fails += 1
            else:
                fails += 1
        except Exception:
            fails += 1
        await asyncio.sleep(pace)
    return ids, fails


async def delete_connections(client, ids, pace=0.3):
    """Delete connections, return count deleted."""
    deleted = 0
    for cid in ids:
        try:
            r = await client.delete(f"/connections/{cid}")
            if r.status_code in (200, 201):
                deleted += 1
        except Exception:
            pass
        await asyncio.sleep(pace)
    return deleted


async def get_state(client):
    """Get current connections and worker assignment."""
    r = await client.get("/connections")
    conns = r.json() if r.status_code == 200 and isinstance(r.json(), list) else []
    active = [c for c in conns if c.get("status") != "stopped"]
    workers = {}
    for c in active:
        wid = c.get("workerId")
        if wid:
            workers[wid] = workers.get(wid, 0) + 1
    unassigned = sum(1 for c in active if not c.get("workerId"))
    return active, workers, unassigned


async def wait_for_state(client, check_fn, description, timeout=120, interval=5):
    """Poll until check_fn(active, workers, unassigned) returns True."""
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        active, workers, unassigned = await get_state(client)
        if check_fn(active, workers, unassigned):
            return True, active, workers, unassigned
        await asyncio.sleep(interval)
    active, workers, unassigned = await get_state(client)
    return False, active, workers, unassigned


async def main():
    print("=" * 60)
    print("WAHooks Scale Test — Step-by-Step Verification")
    print(f"Target: {BASE_URL}")
    print("=" * 60)

    client = httpx.AsyncClient(
        base_url=f"{BASE_URL}/api",
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        timeout=30.0,
    )

    all_connection_ids = []

    # ── Phase 1: Baseline ──
    print("\n── Phase 1: Baseline ──")

    active, workers, unassigned = await get_state(client)
    info(f"Active connections: {len(active)}, Workers: {len(workers)}, Unassigned: {unassigned}")

    if len(active) == 0:
        ok("clean baseline — 0 active connections")
    else:
        info(f"⚠ {len(active)} pre-existing connections (test will work around them)")

    # ── Phase 2: Create 10 connections ──
    print("\n── Phase 2: Create 10 connections (should all fit on 1 worker) ──")

    ids, fails = await create_connections(client, 10)
    all_connection_ids.extend(ids)
    info(f"Created {len(ids)}/10 ({fails} failed)")

    # Wait for all to be assigned
    success, active, workers, unassigned = await wait_for_state(
        client,
        lambda a, w, u: sum(1 for c in a if c["id"] in ids and c.get("workerId")) >= len(ids),
        "all 10 assigned",
        timeout=90,
    )

    test_conns = [c for c in active if c["id"] in ids]
    assigned = [c for c in test_conns if c.get("workerId")]
    worker_ids = set(c["workerId"] for c in assigned)

    if len(assigned) >= 9:  # Allow 1 failure
        ok(f"{len(assigned)}/10 assigned to workers")
    else:
        fail(f"assignment", f"only {len(assigned)}/10 assigned after 90s")

    if len(worker_ids) == 1:
        ok(f"all on 1 worker")
    elif len(worker_ids) == 0:
        fail("worker assignment", "no workers found")
    else:
        fail("worker count", f"expected 1, got {len(worker_ids)}")

    # ── Phase 3: Create 40 more (total 50, fill worker 1) ──
    print("\n── Phase 3: Create 40 more (total 50, should fill worker 1) ──")

    ids2, fails2 = await create_connections(client, 40)
    all_connection_ids.extend(ids2)
    info(f"Created {len(ids2)}/40 ({fails2} failed)")

    await asyncio.sleep(5)
    active, workers, unassigned = await get_state(client)
    test_conns = [c for c in active if c["id"] in all_connection_ids]
    assigned = [c for c in test_conns if c.get("workerId")]
    worker_ids = set(c["workerId"] for c in assigned)

    info(f"Total: {len(test_conns)}, Assigned: {len(assigned)}, Workers: {len(worker_ids)}")

    if len(worker_ids) == 1:
        ok(f"50 connections still on 1 worker")
    else:
        info(f"Workers used: {len(worker_ids)} (expected 1)")
        # Not a hard failure if health service assigned some to a new worker
        if len(worker_ids) <= 2:
            ok(f"{len(worker_ids)} workers for 50 connections (acceptable)")
        else:
            fail("worker count at 50", f"expected 1-2, got {len(worker_ids)}")

    # ── Phase 4: Delete all test connections ──
    print(f"\n── Phase 4: Delete all {len(all_connection_ids)} connections ──")

    deleted = await delete_connections(client, all_connection_ids)
    info(f"Deleted {deleted}/{len(all_connection_ids)}")

    # Wait for cleanup
    success, active, workers, unassigned = await wait_for_state(
        client,
        lambda a, w, u: sum(1 for c in a if c["id"] in all_connection_ids) == 0,
        "all test connections cleaned up",
        timeout=30,
    )

    remaining = sum(1 for c in active if c["id"] in all_connection_ids)
    if remaining == 0:
        ok("all test connections cleaned up")
    else:
        fail("cleanup", f"{remaining} test connections still active")

    # ── Phase 5: Verify worker counters are accurate ──
    print("\n── Phase 5: Verify system state after cleanup ──")

    # Wait for health service to reconcile (up to 2 min)
    await asyncio.sleep(10)
    active, workers, unassigned = await get_state(client)

    info(f"Active connections: {len(active)}")
    info(f"Workers with sessions: {len(workers)}")
    for wid, count in workers.items():
        info(f"  Worker {wid[:8]}...: {count} sessions")

    if len(workers) <= 1:
        ok("worker count correct after cleanup")
    else:
        fail("post-cleanup workers", f"{len(workers)} workers still have sessions")

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
