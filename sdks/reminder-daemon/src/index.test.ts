import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkReminders,
  readReminders,
  readPending,
  writeReminders,
  writePending,
  acquireLock,
  releaseLock,
  type Reminder,
  type PendingItem,
  type DaemonPaths,
} from "./index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;
let paths: DaemonPaths;

/** Stub cron parser that always returns a fixed next date (1 hour from "now"). */
function makeCronParser(nextDate: Date) {
  return (_expr: string) => ({
    next: () => ({
      toDate: () => nextDate,
    }),
  });
}

function makeReminder(overrides: Partial<Reminder> & { id: string }): Reminder {
  return {
    task: "test task",
    chatId: "chat_1",
    schedule: "0 8 * * 1-5",
    oneTime: false,
    createdAt: new Date().toISOString(),
    lastFiredAt: null,
    nextRunAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago (due)
    ...overrides,
  };
}

// ─── Setup / Teardown ────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wahooks-test-"));
  paths = {
    remindersFile: path.join(tmpDir, "reminders.json"),
    pendingFile: path.join(tmpDir, "pending.json"),
    lockFile: path.join(tmpDir, ".pending.lock"),
  };
});

afterEach(() => {
  // Clean up lock file if left behind
  releaseLock(paths.lockFile);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe("readReminders / writeReminders", () => {
  it("returns empty object when file does not exist", () => {
    const result = readReminders(paths.remindersFile);
    assert.deepEqual(result, {});
  });

  it("round-trips reminders through write and read", () => {
    const reminder = makeReminder({ id: "r1" });
    writeReminders(paths.remindersFile, { r1: reminder });
    const result = readReminders(paths.remindersFile);
    assert.deepEqual(result, { r1: reminder });
  });
});

describe("readPending / writePending", () => {
  it("returns empty array when file does not exist", () => {
    const result = readPending(paths.pendingFile);
    assert.deepEqual(result, []);
  });

  it("round-trips pending items through write and read", () => {
    const item: PendingItem = {
      reminderId: "r1",
      task: "test",
      chatId: "chat_1",
      scheduledFor: new Date().toISOString(),
      addedAt: new Date().toISOString(),
    };
    writePending(paths.pendingFile, [item]);
    const result = readPending(paths.pendingFile);
    assert.deepEqual(result, [item]);
  });
});

describe("acquireLock / releaseLock", () => {
  it("acquires lock when no lock file exists", () => {
    assert.equal(acquireLock(paths.lockFile), true);
    assert.equal(fs.existsSync(paths.lockFile), true);
    releaseLock(paths.lockFile);
  });

  it("fails to acquire lock when already held by this process", () => {
    assert.equal(acquireLock(paths.lockFile), true);
    // Same PID holds it, process.kill(pid, 0) will succeed → lock is valid
    assert.equal(acquireLock(paths.lockFile), false);
    releaseLock(paths.lockFile);
  });

  it("steals lock from dead process", () => {
    // Write a lock file with a PID that doesn't exist
    fs.writeFileSync(paths.lockFile, "999999999", { flag: "wx" });
    assert.equal(acquireLock(paths.lockFile), true);
    releaseLock(paths.lockFile);
  });

  it("release removes lock file", () => {
    acquireLock(paths.lockFile);
    releaseLock(paths.lockFile);
    assert.equal(fs.existsSync(paths.lockFile), false);
  });
});

describe("checkReminders", () => {
  const now = new Date("2025-06-15T10:00:00.000Z");
  const nextRun = new Date("2025-06-16T08:00:00.000Z");
  const cronParser = makeCronParser(nextRun);

  it("adds due reminder to pending queue", () => {
    const reminder = makeReminder({
      id: "r1",
      nextRunAt: new Date("2025-06-15T09:00:00.000Z").toISOString(), // 1h before now
    });
    writeReminders(paths.remindersFile, { r1: reminder });
    writePending(paths.pendingFile, []);

    checkReminders(paths, cronParser, now);

    const pending = readPending(paths.pendingFile);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].reminderId, "r1");
    assert.equal(pending[0].task, "test task");
    assert.equal(pending[0].chatId, "chat_1");
    assert.equal(pending[0].scheduledFor, reminder.nextRunAt);
    assert.equal(pending[0].addedAt, now.toISOString());
  });

  it("does not fire reminders that are not yet due", () => {
    const reminder = makeReminder({
      id: "r1",
      nextRunAt: new Date("2025-06-15T11:00:00.000Z").toISOString(), // 1h after now
    });
    writeReminders(paths.remindersFile, { r1: reminder });
    writePending(paths.pendingFile, []);

    checkReminders(paths, cronParser, now);

    const pending = readPending(paths.pendingFile);
    assert.equal(pending.length, 0);

    // Reminder should still exist unchanged
    const reminders = readReminders(paths.remindersFile);
    assert.equal(Object.keys(reminders).length, 1);
    assert.equal(reminders["r1"].nextRunAt, reminder.nextRunAt);
  });

  it("removes one-time reminder after firing", () => {
    const reminder = makeReminder({
      id: "r1",
      oneTime: true,
      nextRunAt: new Date("2025-06-15T09:00:00.000Z").toISOString(),
    });
    writeReminders(paths.remindersFile, { r1: reminder });
    writePending(paths.pendingFile, []);

    checkReminders(paths, cronParser, now);

    // Pending should have the item
    const pending = readPending(paths.pendingFile);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].reminderId, "r1");

    // Reminder should be gone
    const reminders = readReminders(paths.remindersFile);
    assert.equal(Object.keys(reminders).length, 0);
  });

  it("updates nextRunAt for recurring reminder after firing", () => {
    const reminder = makeReminder({
      id: "r1",
      oneTime: false,
      schedule: "0 8 * * 1-5",
      nextRunAt: new Date("2025-06-15T09:00:00.000Z").toISOString(),
    });
    writeReminders(paths.remindersFile, { r1: reminder });
    writePending(paths.pendingFile, []);

    checkReminders(paths, cronParser, now);

    const reminders = readReminders(paths.remindersFile);
    assert.equal(Object.keys(reminders).length, 1);
    assert.equal(reminders["r1"].nextRunAt, nextRun.toISOString());
    assert.equal(reminders["r1"].lastFiredAt, now.toISOString());
  });

  it("prunes stale pending items older than 24 hours", () => {
    const staleItem: PendingItem = {
      reminderId: "old",
      task: "stale task",
      chatId: "chat_1",
      scheduledFor: new Date("2025-06-13T08:00:00.000Z").toISOString(),
      addedAt: new Date("2025-06-13T08:00:00.000Z").toISOString(), // >24h before now
    };
    const freshItem: PendingItem = {
      reminderId: "fresh",
      task: "fresh task",
      chatId: "chat_1",
      scheduledFor: new Date("2025-06-15T09:00:00.000Z").toISOString(),
      addedAt: new Date("2025-06-15T09:30:00.000Z").toISOString(), // 30min before now
    };
    writePending(paths.pendingFile, [staleItem, freshItem]);
    writeReminders(paths.remindersFile, {}); // no reminders to fire

    checkReminders(paths, cronParser, now);

    const pending = readPending(paths.pendingFile);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].reminderId, "fresh");
  });

  it("handles multiple reminders — fires due, skips future", () => {
    const dueReminder = makeReminder({
      id: "r_due",
      task: "due task",
      oneTime: true,
      nextRunAt: new Date("2025-06-15T09:00:00.000Z").toISOString(),
    });
    const futureReminder = makeReminder({
      id: "r_future",
      task: "future task",
      nextRunAt: new Date("2025-06-16T09:00:00.000Z").toISOString(),
    });
    writeReminders(paths.remindersFile, { r_due: dueReminder, r_future: futureReminder });
    writePending(paths.pendingFile, []);

    checkReminders(paths, cronParser, now);

    const pending = readPending(paths.pendingFile);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].reminderId, "r_due");

    const reminders = readReminders(paths.remindersFile);
    // one-time r_due removed, r_future still exists
    assert.equal(Object.keys(reminders).length, 1);
    assert.ok(reminders["r_future"]);
  });

  it("does nothing when reminders file is missing", () => {
    // No files created at all
    checkReminders(paths, cronParser, now);

    // No pending file should be created (nothing changed)
    assert.equal(fs.existsSync(paths.pendingFile), false);
  });

  it("appends to existing pending items", () => {
    const existingItem: PendingItem = {
      reminderId: "existing",
      task: "existing task",
      chatId: "chat_1",
      scheduledFor: now.toISOString(),
      addedAt: now.toISOString(),
    };
    writePending(paths.pendingFile, [existingItem]);

    const reminder = makeReminder({
      id: "r1",
      oneTime: true,
      nextRunAt: new Date("2025-06-15T09:00:00.000Z").toISOString(),
    });
    writeReminders(paths.remindersFile, { r1: reminder });

    checkReminders(paths, cronParser, now);

    const pending = readPending(paths.pendingFile);
    assert.equal(pending.length, 2);
    assert.equal(pending[0].reminderId, "existing");
    assert.equal(pending[1].reminderId, "r1");
  });

  it("handles invalid cron expression gracefully", () => {
    const badCronParser = (_expr: string) => {
      throw new Error("Invalid cron");
    };
    const reminder = makeReminder({
      id: "r1",
      oneTime: false,
      nextRunAt: new Date("2025-06-15T09:00:00.000Z").toISOString(),
    });
    writeReminders(paths.remindersFile, { r1: reminder });
    writePending(paths.pendingFile, []);

    // Should not throw
    checkReminders(paths, badCronParser, now);

    // Pending should still get the item
    const pending = readPending(paths.pendingFile);
    assert.equal(pending.length, 1);

    // Reminder should remain unchanged (no nextRunAt update since cron failed)
    const reminders = readReminders(paths.remindersFile);
    assert.equal(Object.keys(reminders).length, 1);
    assert.equal(reminders["r1"].nextRunAt, reminder.nextRunAt);
  });

  it("cleans up lock file after check", () => {
    writeReminders(paths.remindersFile, {});
    writePending(paths.pendingFile, []);

    checkReminders(paths, cronParser, now);

    assert.equal(fs.existsSync(paths.lockFile), false);
  });
});
