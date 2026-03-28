#!/usr/bin/env node
/**
 * WAHooks Reminder Daemon
 *
 * Runs in the background (via launchd/systemd). Every 30s, checks
 * reminders.json for due items and appends them to pending.json.
 * The channel picks up pending items and delivers them to Claude.
 *
 * Files:
 *   ~/.wahooks/reminders.json — active reminders (managed by Claude via channel tools)
 *   ~/.wahooks/pending.json   — queue of due reminders waiting for Claude
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Use dynamic import for cron-parser (ESM compat)
let parseExpression: (expr: string) => { next: () => { toDate: () => Date } };

const WAHOOKS_DIR = path.join(os.homedir(), ".wahooks");
const REMINDERS_FILE = path.join(WAHOOKS_DIR, "reminders.json");
const PENDING_FILE = path.join(WAHOOKS_DIR, "pending.json");
const LOCK_FILE = path.join(WAHOOKS_DIR, ".pending.lock");
const CHECK_INTERVAL = 30_000; // 30 seconds
const STALE_HOURS = 24;

// ─── Types ──────────────────────────────────────────────────────────────

interface Reminder {
  id: string;
  task: string;
  chatId: string;
  schedule: string; // cron expression
  oneTime: boolean;
  createdAt: string;
  lastFiredAt: string | null;
  nextRunAt: string;
}

interface PendingItem {
  reminderId: string;
  task: string;
  chatId: string;
  scheduledFor: string;
  addedAt: string;
}

// ─── File helpers with locking ──────────────────────────────────────────

function acquireLock(): boolean {
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    // Check if lock is stale (owner process dead)
    try {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8"));
      try {
        process.kill(pid, 0); // check if process exists
        return false; // process alive, lock is valid
      } catch {
        // Process dead, steal lock
        fs.writeFileSync(LOCK_FILE, String(process.pid));
        return true;
      }
    } catch {
      return false;
    }
  }
}

function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

function readReminders(): Record<string, Reminder> {
  try {
    return JSON.parse(fs.readFileSync(REMINDERS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeReminders(reminders: Record<string, Reminder>): void {
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2) + "\n", { mode: 0o600 });
}

function readPending(): PendingItem[] {
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writePending(items: PendingItem[]): void {
  fs.writeFileSync(PENDING_FILE, JSON.stringify(items, null, 2) + "\n", { mode: 0o600 });
}

// ─── Core logic ─────────────────────────────────────────────────────────

function checkReminders(): void {
  if (!acquireLock()) {
    return; // another process is writing
  }

  try {
    const reminders = readReminders();
    const pending = readPending();
    const now = new Date();
    let changed = false;
    let pendingChanged = false;

    // Prune stale pending items (older than 24h)
    const cutoff = new Date(now.getTime() - STALE_HOURS * 60 * 60 * 1000);
    const prunedPending = pending.filter((p) => new Date(p.addedAt) > cutoff);
    if (prunedPending.length !== pending.length) {
      pendingChanged = true;
    }

    for (const [id, reminder] of Object.entries(reminders)) {
      const nextRun = new Date(reminder.nextRunAt);

      if (nextRun <= now) {
        // Reminder is due — add to pending queue
        prunedPending.push({
          reminderId: id,
          task: reminder.task,
          chatId: reminder.chatId,
          scheduledFor: reminder.nextRunAt,
          addedAt: now.toISOString(),
        });
        pendingChanged = true;

        if (reminder.oneTime) {
          // Remove one-time reminders after firing
          delete reminders[id];
          changed = true;
          console.log(`[reminders] Fired one-time reminder ${id}: ${reminder.task.slice(0, 60)}`);
        } else {
          // Calculate next run for recurring reminders
          try {
            const interval = parseExpression(reminder.schedule);
            const next = interval.next().toDate();
            reminders[id] = {
              ...reminder,
              lastFiredAt: now.toISOString(),
              nextRunAt: next.toISOString(),
            };
            changed = true;
            console.log(`[reminders] Fired recurring reminder ${id}, next: ${next.toISOString()}`);
          } catch {
            console.error(`[reminders] Invalid cron for ${id}: ${reminder.schedule}`);
          }
        }
      }
    }

    if (changed) writeReminders(reminders);
    if (pendingChanged) writePending(prunedPending);
  } finally {
    releaseLock();
  }
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  // Ensure directory exists
  fs.mkdirSync(WAHOOKS_DIR, { recursive: true });

  // Load cron-parser
  const cronParser = await import("cron-parser");
  parseExpression = cronParser.parseExpression;

  console.log(`[reminders] Daemon started — checking every ${CHECK_INTERVAL / 1000}s`);
  console.log(`[reminders] Reminders: ${REMINDERS_FILE}`);
  console.log(`[reminders] Pending: ${PENDING_FILE}`);

  // Run immediately on start
  checkReminders();

  // Then check every 30s
  setInterval(checkReminders, CHECK_INTERVAL);
}

main().catch((err) => {
  console.error("[reminders] Fatal:", err.message);
  process.exit(1);
});
