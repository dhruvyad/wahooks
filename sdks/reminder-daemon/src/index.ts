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

export interface Reminder {
  id: string;
  task: string;
  chatId: string;
  schedule: string; // cron expression
  oneTime: boolean;
  createdAt: string;
  lastFiredAt: string | null;
  nextRunAt: string;
}

export interface PendingItem {
  reminderId: string;
  task: string;
  chatId: string;
  scheduledFor: string;
  addedAt: string;
}

export interface DaemonPaths {
  remindersFile: string;
  pendingFile: string;
  lockFile: string;
}

// ─── File helpers with locking ──────────────────────────────────────────

export function acquireLock(lockFile: string): boolean {
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    // Check if lock is stale (owner process dead)
    try {
      const pid = parseInt(fs.readFileSync(lockFile, "utf-8"));
      try {
        process.kill(pid, 0); // check if process exists
        return false; // process alive, lock is valid
      } catch {
        // Process dead, steal lock
        fs.writeFileSync(lockFile, String(process.pid));
        return true;
      }
    } catch {
      return false;
    }
  }
}

export function releaseLock(lockFile: string): void {
  try {
    fs.unlinkSync(lockFile);
  } catch {
    // ignore
  }
}

export function readReminders(remindersFile: string): Record<string, Reminder> {
  try {
    return JSON.parse(fs.readFileSync(remindersFile, "utf-8"));
  } catch {
    return {};
  }
}

export function writeReminders(remindersFile: string, reminders: Record<string, Reminder>): void {
  fs.writeFileSync(remindersFile, JSON.stringify(reminders, null, 2) + "\n", { mode: 0o600 });
}

export function readPending(pendingFile: string): PendingItem[] {
  try {
    return JSON.parse(fs.readFileSync(pendingFile, "utf-8"));
  } catch {
    return [];
  }
}

export function writePending(pendingFile: string, items: PendingItem[]): void {
  fs.writeFileSync(pendingFile, JSON.stringify(items, null, 2) + "\n", { mode: 0o600 });
}

// ─── Core logic ─────────────────────────────────────────────────────────

export function checkReminders(
  paths: DaemonPaths,
  cronParser: (expr: string) => { next: () => { toDate: () => Date } },
  now?: Date,
): void {
  if (!acquireLock(paths.lockFile)) {
    return; // another process is writing
  }

  try {
    const reminders = readReminders(paths.remindersFile);
    const pending = readPending(paths.pendingFile);
    const currentTime = now ?? new Date();
    let changed = false;
    let pendingChanged = false;

    // Prune stale pending items (older than 24h)
    const cutoff = new Date(currentTime.getTime() - STALE_HOURS * 60 * 60 * 1000);
    const prunedPending = pending.filter((p) => new Date(p.addedAt) > cutoff);
    if (prunedPending.length !== pending.length) {
      pendingChanged = true;
    }

    for (const [id, reminder] of Object.entries(reminders)) {
      const nextRun = new Date(reminder.nextRunAt);

      if (nextRun <= currentTime) {
        // Reminder is due — add to pending queue
        prunedPending.push({
          reminderId: id,
          task: reminder.task,
          chatId: reminder.chatId,
          scheduledFor: reminder.nextRunAt,
          addedAt: currentTime.toISOString(),
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
            const interval = cronParser(reminder.schedule);
            const next = interval.next().toDate();
            reminders[id] = {
              ...reminder,
              lastFiredAt: currentTime.toISOString(),
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

    if (changed) writeReminders(paths.remindersFile, reminders);
    if (pendingChanged) writePending(paths.pendingFile, prunedPending);
  } finally {
    releaseLock(paths.lockFile);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  // Ensure directory exists
  fs.mkdirSync(WAHOOKS_DIR, { recursive: true });

  // Load cron-parser
  const cronParser = await import("cron-parser");
  parseExpression = cronParser.parseExpression;

  const paths: DaemonPaths = {
    remindersFile: REMINDERS_FILE,
    pendingFile: PENDING_FILE,
    lockFile: LOCK_FILE,
  };

  console.log(`[reminders] Daemon started — checking every ${CHECK_INTERVAL / 1000}s`);
  console.log(`[reminders] Reminders: ${REMINDERS_FILE}`);
  console.log(`[reminders] Pending: ${PENDING_FILE}`);

  // Run immediately on start
  checkReminders(paths, parseExpression);

  // Then check every 30s
  setInterval(() => checkReminders(paths, parseExpression), CHECK_INTERVAL);
}

// Only run daemon when executed directly (not when imported for testing)
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("/index.js") ||
    process.argv[1].endsWith("/index.ts")) &&
  !process.argv.includes("--test");

if (isDirectExecution) {
  main().catch((err) => {
    console.error("[reminders] Fatal:", err.message);
    process.exit(1);
  });
}
