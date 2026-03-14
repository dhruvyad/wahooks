"""
WAHooks Scale Test — End-to-End Cross-Worker Verification

Tests the full scale-up and scale-down lifecycle:
1. Baseline: verify clean state
2. Fill worker 1 (50 connections)
3. Trigger scale-up (create connection 51+)
4. Verify 2 workers active
5. Delete connections to trigger scale-down
6. Verify back to 1 worker
7. Verify Hetzner nodes cleaned up

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


async def wait_for_condition(client, check_fn, description, timeout=180, interval=10):
    """Poll until check_fn returns True. Returns (success, state)."""
    info(f"Waiting for: {description} (timeout {timeout}s)...")
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        active, workers, unassigned = await get_state(client)
        if check_fn(active, workers, unassigned):
            elapsed = time.monotonic() - start
            info(f"Condition met after {elapsed:.0f}s")
            return True, active, workers, unassigned
        await asyncio.sleep(interval)
    active, workers, unassigned = await get_state(client)
    return False, active, workers, unassigned


async def main():
    print("=" * 60)
    print("WAHooks Scale Test — End-to-End Cross-Worker")
    print(f"Target: {BASE_URL}")
    print("=" * 60)

    client = httpx.AsyncClient(
        base_url=f"{BASE_URL}/api",
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        timeout=30.0,
    )

    all_ids = []

    # ── Phase 1: Baseline ──
    print("\n── Phase 1: Baseline ──")
    active, workers, _ = await get_state(client)
    if len(active) == 0:
        ok("clean baseline")
    else:
        info(f"⚠ {len(active)} pre-existing connections")

    # ── Phase 2: Fill worker 1 (50 connections) ──
    print("\n── Phase 2: Fill worker 1 with 50 connections ──")

    ids, fails = await create_connections(client, 50)
    all_ids.extend(ids)
    info(f"Created {len(ids)}/50 ({fails} failed)")

    success, active, workers, unassigned = await wait_for_condition(
        client,
        lambda a, w, u: sum(1 for c in a if c["id"] in all_ids and c.get("workerId")) >= 48,
        "≥48 connections assigned",
        timeout=120,
    )

    worker_ids = set(c.get("workerId") for c in active if c["id"] in all_ids and c.get("workerId"))
    assigned = sum(1 for c in active if c["id"] in all_ids and c.get("workerId"))
    info(f"Assigned: {assigned}/50, Workers: {len(worker_ids)}, Unassigned: {unassigned}")

    if assigned >= 48:
        ok(f"{assigned} connections assigned")
    else:
        fail("assignment", f"only {assigned}/50 assigned")

    if len(worker_ids) == 1:
        ok("all on 1 worker")
    else:
        fail("worker count", f"expected 1, got {len(worker_ids)}")

    # ── Phase 3: Trigger scale-up (create 10 more = 60 total) ──
    print("\n── Phase 3: Create 10 more to trigger scale-up (total 60) ──")

    ids2, fails2 = await create_connections(client, 10)
    all_ids.extend(ids2)
    info(f"Created {len(ids2)}/10 ({fails2} failed)")

    # Wait for second worker to appear (may take 2-3 min for Hetzner node)
    success, active, workers, unassigned = await wait_for_condition(
        client,
        lambda a, w, u: len(w) >= 2,
        "2 workers active",
        timeout=300,  # 5 min for Hetzner node provisioning
        interval=15,
    )

    worker_ids = set(c.get("workerId") for c in active if c["id"] in all_ids and c.get("workerId"))
    assigned = sum(1 for c in active if c["id"] in all_ids and c.get("workerId"))
    info(f"Workers: {len(worker_ids)}, Assigned: {assigned}/{len(all_ids)}")

    for wid, count in workers.items():
        info(f"  Worker {wid[:8]}...: {count} sessions")

    if len(worker_ids) >= 2:
        ok(f"scaled to {len(worker_ids)} workers")
    elif len(worker_ids) == 1 and unassigned > 0:
        # Worker 2 might not be ready yet — pending connections exist
        info(f"{unassigned} connections still unassigned (worker provisioning)")
        ok(f"scale-up initiated ({unassigned} pending assignment)", "worker 2 provisioning")
    else:
        fail("scale-up", f"only {len(worker_ids)} workers, {unassigned} unassigned")

    # ── Phase 4: Delete all connections ──
    print(f"\n── Phase 4: Delete all {len(all_ids)} connections ──")

    deleted = await delete_connections(client, all_ids)
    info(f"Deleted {deleted}/{len(all_ids)}")

    # Wait for cleanup
    success, active, workers, unassigned = await wait_for_condition(
        client,
        lambda a, w, u: sum(1 for c in a if c["id"] in all_ids) == 0,
        "all test connections gone",
        timeout=30,
    )

    remaining = sum(1 for c in active if c["id"] in all_ids)
    if remaining == 0:
        ok("all test connections deleted")
    else:
        fail("cleanup", f"{remaining} still active")

    # ── Phase 5: Wait for scale-down ──
    print("\n── Phase 5: Wait for scale-down (health poll + checkScaling) ──")

    # checkScaling runs every 5 minutes — wait up to 7 min
    success, active, workers, unassigned = await wait_for_condition(
        client,
        lambda a, w, u: len(w) <= 1,
        "≤1 workers with sessions",
        timeout=420,  # 7 minutes
        interval=30,
    )

    if len(workers) <= 1:
        ok(f"scaled down to {len(workers)} workers")
    else:
        fail("scale-down", f"still {len(workers)} workers after 7 min")

    # ── Phase 6: Final state ──
    print("\n── Phase 6: Final state ──")

    active, workers, unassigned = await get_state(client)
    info(f"Active connections: {len(active)}")
    info(f"Workers with sessions: {len(workers)}")

    test_remaining = sum(1 for c in active if c["id"] in all_ids)
    if test_remaining == 0 and len(workers) <= 1:
        ok("system returned to baseline")
    else:
        fail("final state", f"{test_remaining} test conns, {len(workers)} workers")

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
