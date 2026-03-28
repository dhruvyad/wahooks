#!/usr/bin/env node
/**
 * WAHooks Reminder Daemon
 *
 * Runs in the background (via launchd). Every 30s, checks
 * reminders.json for due items and appends them to pending.json.
 * The channel picks up pending items and delivers them to Claude.
 *
 * Packaged with @wahooks/channel — binary: wahooks-reminders
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const WAHOOKS_DIR = path.join(os.homedir(), ".wahooks");
const REMINDERS_FILE = path.join(WAHOOKS_DIR, "reminders.json");
const PENDING_FILE = path.join(WAHOOKS_DIR, "pending.json");
const LOCK_FILE = path.join(WAHOOKS_DIR, ".pending.lock");
const CHECK_INTERVAL = 30_000;
const STALE_HOURS = 24;

interface Reminder {
  id: string;
  task: string;
  chatId: string;
  schedule: string;
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

function acquireLock(): boolean {
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    try {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8"));
      try { process.kill(pid, 0); return false; } catch { fs.writeFileSync(LOCK_FILE, String(process.pid)); return true; }
    } catch { return false; }
  }
}

function releaseLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return fallback; }
}

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

function checkReminders(parseExpression: (expr: string) => { next: () => { toDate: () => Date } }): void {
  if (!acquireLock()) return;

  try {
    const reminders = readJson<Record<string, Reminder>>(REMINDERS_FILE, {});
    const pending = readJson<PendingItem[]>(PENDING_FILE, []);
    const now = new Date();
    let changed = false;
    let pendingChanged = false;

    // Prune stale (>24h)
    const cutoff = new Date(now.getTime() - STALE_HOURS * 60 * 60 * 1000);
    const active = pending.filter((p) => new Date(p.addedAt) > cutoff);
    if (active.length !== pending.length) pendingChanged = true;

    for (const [id, rem] of Object.entries(reminders)) {
      if (new Date(rem.nextRunAt) <= now) {
        active.push({
          reminderId: id,
          task: rem.task,
          chatId: rem.chatId,
          scheduledFor: rem.nextRunAt,
          addedAt: now.toISOString(),
        });
        pendingChanged = true;

        if (rem.oneTime) {
          delete reminders[id];
          changed = true;
          console.log(`[reminders] Fired one-time: ${id}`);
        } else {
          try {
            const next = parseExpression(rem.schedule).next().toDate();
            reminders[id] = { ...rem, lastFiredAt: now.toISOString(), nextRunAt: next.toISOString() };
            changed = true;
            console.log(`[reminders] Fired recurring: ${id}, next: ${next.toISOString()}`);
          } catch {
            console.error(`[reminders] Invalid cron for ${id}: ${rem.schedule}`);
          }
        }
      }
    }

    if (changed) writeJson(REMINDERS_FILE, reminders);
    if (pendingChanged) writeJson(PENDING_FILE, active);
  } finally {
    releaseLock();
  }
}

async function main() {
  fs.mkdirSync(WAHOOKS_DIR, { recursive: true });

  const cronParser = await import("cron-parser");
  const parseExpression = cronParser.default?.parseExpression ?? cronParser.parseExpression;

  console.log(`[reminders] Daemon started — checking every ${CHECK_INTERVAL / 1000}s`);

  checkReminders(parseExpression);
  setInterval(() => checkReminders(parseExpression), CHECK_INTERVAL);
}

main().catch((err) => {
  console.error("[reminders] Fatal:", err.message);
  process.exit(1);
});
