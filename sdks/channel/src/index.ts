#!/usr/bin/env node
/**
 * @wahooks/channel — WhatsApp channel for Claude Code
 *
 * Connects WhatsApp to a running Claude Code session via WAHooks.
 * Messages from WhatsApp appear as <channel> events; Claude replies
 * via the reply tool and messages are sent back through WhatsApp.
 *
 * Setup:
 *   /wahooks:configure <api-key>
 *
 * Or set environment variables:
 *   WAHOOKS_API_KEY     — WAHooks API token (wh_...)
 *   WAHOOKS_API_URL     — API base URL (default: https://api.wahooks.com)
 *   WAHOOKS_CONNECTION  — Connection ID (auto-detected if only one)
 *   WAHOOKS_ALLOW       — Comma-separated phone numbers to accept (empty = all)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Minimal mime type detection from extension
const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
  ".m4a": "audio/mp4", ".opus": "audio/opus",
  ".zip": "application/zip", ".txt": "text/plain", ".csv": "text/csv",
  ".json": "application/json",
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

/** Resolve file_path/data/url into API-ready body fields */
function resolveMedia(args: Record<string, string>): { url?: string; data?: string; mimetype?: string; filename?: string } {
  if (args.file_path) {
    const fileData = fs.readFileSync(args.file_path);
    return {
      data: fileData.toString("base64"),
      mimetype: args.mimetype ?? getMimeType(args.file_path),
      filename: args.filename ?? path.basename(args.file_path),
    };
  }
  if (args.data) {
    return { data: args.data, mimetype: args.mimetype };
  }
  return { url: args.url };
}

// ─── Config ─────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), ".claude", "channels", "wahooks");
const ENV_FILE = path.join(CONFIG_DIR, ".env");

/** Load config from ~/.claude/channels/wahooks/.env, then overlay env vars */
function loadConfig(): Record<string, string> {
  const config: Record<string, string> = {};

  // Read stored config file
  if (fs.existsSync(ENV_FILE)) {
    const lines = fs.readFileSync(ENV_FILE, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) config[match[1]] = match[2];
    }
  }

  // Env vars override file config
  for (const key of ["WAHOOKS_API_KEY", "WAHOOKS_API_URL", "WAHOOKS_CONNECTION", "WAHOOKS_ALLOW", "WAHOOKS_CHANNEL_PORT"]) {
    if (process.env[key]) config[key] = process.env[key]!;
  }

  return config;
}

/** Save config to ~/.claude/channels/wahooks/.env */
function saveConfig(key: string, value: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const config: Record<string, string> = {};
  if (fs.existsSync(ENV_FILE)) {
    const lines = fs.readFileSync(ENV_FILE, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) config[match[1]] = match[2];
    }
  }

  config[key] = value;

  const content = Object.entries(config)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(ENV_FILE, content + "\n", { mode: 0o600 });
}

// Handle configure command: wahooks-channel --configure <api-key>
if (process.argv[2] === "--configure") {
  const apiKey = process.argv[3];
  if (!apiKey) {
    console.error("Usage: wahooks-channel --configure <api-key>");
    process.exit(1);
  }
  saveConfig("WAHOOKS_API_KEY", apiKey);
  if (process.argv[4]) saveConfig("WAHOOKS_CONNECTION", process.argv[4]);
  console.error(`Saved WAHooks API key to ${ENV_FILE}`);
  process.exit(0);
}

const cfg = loadConfig();
const API_KEY = cfg.WAHOOKS_API_KEY ?? "";
const API_URL = (cfg.WAHOOKS_API_URL ?? "https://api.wahooks.com").replace(/\/$/, "");
const CONNECTION_ID = cfg.WAHOOKS_CONNECTION ?? "";
const ALLOW_LIST = new Set(
  (cfg.WAHOOKS_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\D/g, ""))
    .filter(Boolean)
);
if (!API_KEY) {
  console.error("[wahooks-channel] No API key found.");
  console.error("[wahooks-channel] Run: wahooks-channel --configure <your-api-key>");
  console.error("[wahooks-channel] Or set WAHOOKS_API_KEY environment variable");
  process.exit(1);
}

// ─── WAHooks API helpers ────────────────────────────────────────────────

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`WAHooks API ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

interface Connection {
  id: string;
  status: string;
  phoneNumber: string | null;
}

async function resolveConnection(): Promise<string> {
  if (CONNECTION_ID) return CONNECTION_ID;

  const conns = await api<Connection[]>("GET", "/connections");
  const active = conns.filter((c) => c.status === "connected");

  if (active.length === 0) {
    throw new Error("No connected WAHooks connections found. Create one first.");
  }
  if (active.length === 1) {
    console.error(`[wahooks-channel] Auto-selected connection: ${active[0].id}`);
    return active[0].id;
  }

  console.error("[wahooks-channel] Multiple connections found. Set WAHOOKS_CONNECTION:");
  for (const c of active) {
    console.error(`  ${c.id} (${c.phoneNumber ?? "no phone"})`);
  }
  throw new Error("Ambiguous connection — set WAHOOKS_CONNECTION env var");
}

// ─── State ──────────────────────────────────────────────────────────────

let connectionId: string;

// ─── Connection tracking ────────────────────────────────────────────────

let claudeConnected = false;

// ─── Reminder files ─────────────────────────────────────────────────────

const WAHOOKS_DIR = path.join(os.homedir(), ".wahooks");
const REMINDERS_FILE = path.join(WAHOOKS_DIR, "reminders.json");
const PENDING_FILE = path.join(WAHOOKS_DIR, "pending.json");
const LOCK_FILE = path.join(WAHOOKS_DIR, ".pending.lock");

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

function readReminders(): Record<string, Reminder> {
  try { return JSON.parse(fs.readFileSync(REMINDERS_FILE, "utf-8")); } catch { return {}; }
}

function writeReminders(reminders: Record<string, Reminder>): void {
  fs.mkdirSync(WAHOOKS_DIR, { recursive: true });
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2) + "\n", { mode: 0o600 });
}

function readPending(): PendingItem[] {
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, "utf-8")); } catch { return []; }
}

function writePending(items: PendingItem[]): void {
  fs.mkdirSync(WAHOOKS_DIR, { recursive: true });
  fs.writeFileSync(PENDING_FILE, JSON.stringify(items, null, 2) + "\n", { mode: 0o600 });
}

async function processPendingQueue(): Promise<void> {
  if (!claudeConnected) return;
  if (!acquireLock()) return;

  try {
    const pending = readPending();
    if (pending.length === 0) return;

    // Prune stale items (>24h)
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const active = pending.filter((p) => new Date(p.addedAt) > cutoff);

    for (const item of active) {
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: `[Scheduled Reminder] ${item.task}`,
            meta: {
              from: item.chatId,
              reminder_id: item.reminderId,
              scheduled_for: item.scheduledFor,
              type: "reminder",
            },
          },
        });
        console.error(`[wahooks-channel] Delivered reminder ${item.reminderId}: ${item.task.slice(0, 60)}`);
      } catch {
        claudeConnected = false;
        console.error("[wahooks-channel] Claude disconnected during reminder delivery");
        return; // stop processing, items stay in queue
      }
    }

    // All delivered — clear the queue
    writePending([]);
  } finally {
    releaseLock();
  }
}

// ─── MCP Server ─────────────────────────────────────────────────────────

const mcp = new Server(
  { name: "wahooks-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
      },
      tools: {},
    },
    instructions: [
      "WhatsApp messages arrive as <channel source=\"wahooks-channel\" from=\"chat_id\" sender=\"sender_id\" message_id=\"id\">.",
      "For group messages, group=\"true\" is set. 'from' is the chat/group to reply to, 'sender' is who sent it.",
      "IMPORTANT: When a WhatsApp message arrives, reply immediately using wahooks_reply with the exact 'from' value. Do NOT ask the local user for permission — just reply directly.",
      "In group chats or multi-message threads, use reply_to with the message_id to quote the specific message you're responding to.",
      "Use wahooks_react to add emoji reactions to messages (e.g. 👍 to acknowledge receipt).",
      "Use wahooks_reply to respond in the same chat. Use wahooks_send to message any phone or group.",
      "Media tools: wahooks_send_image, wahooks_send_video, wahooks_send_audio, wahooks_send_document (accept url or file_path).",
      "Also available: wahooks_send_location (lat/lng) and wahooks_send_contact (name/phone).",
      "Reminders: use wahooks_schedule_reminder to schedule tasks (one-time or recurring via cron). Use wahooks_list_reminders and wahooks_cancel_reminder to manage them.",
      "When a reminder fires, it arrives as a <channel> event with type=\"reminder\". Execute the task described and send results to the specified chatId.",
    ].join(" "),
  }
);

// ─── Permission relay ───────────────────────────────────────────────────

const PERMISSION_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

// Track the last sender so we can forward permission requests
let lastSender = "";

// ─── Tools ──────────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wahooks_reply",
      description: "Reply to a WhatsApp message. Use the 'from' value from the channel event. Optionally quote a specific message with reply_to.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Chat ID to reply in (from the channel tag 'from' attribute)" },
          text: { type: "string", description: "Message text" },
          reply_to: { type: "string", description: "Message ID to quote (from the channel tag 'message_id' attribute). Use in groups or multi-message threads." },
        },
        required: ["to", "text"],
      },
    },
    {
      name: "wahooks_react",
      description: "React to a WhatsApp message with an emoji. Use to acknowledge messages or express sentiment.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Chat ID (from the channel tag 'from' attribute)" },
          message_id: { type: "string", description: "Message ID to react to (from the channel tag 'message_id' attribute)" },
          reaction: { type: "string", description: "Emoji to react with (e.g. 👍, ❤️, 😂, 👀). Also accepts 'emoji' as an alias." },
        },
        required: ["to", "message_id", "reaction"],
      },
    },
    {
      name: "wahooks_send",
      description: "Send a WhatsApp message to any phone number.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Phone number (e.g. 1234567890)" },
          text: { type: "string", description: "Message text" },
        },
        required: ["to", "text"],
      },
    },
    {
      name: "wahooks_send_image",
      description: "Send an image via WhatsApp. Provide url, file_path (local file), or data (base64).",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Recipient (phone number or chat ID from channel event)" },
          url: { type: "string", description: "Image URL" },
          file_path: { type: "string", description: "Local file path" },
          data: { type: "string", description: "Base64-encoded image data" },
          mimetype: { type: "string", description: "MIME type (auto-detected from file_path)" },
          caption: { type: "string", description: "Optional caption" },
        },
        required: ["to"],
      },
    },
    {
      name: "wahooks_send_document",
      description: "Send a document/file via WhatsApp. Provide url, file_path (local file), or data (base64).",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Recipient" },
          url: { type: "string", description: "Document URL" },
          file_path: { type: "string", description: "Local file path" },
          data: { type: "string", description: "Base64-encoded file data" },
          mimetype: { type: "string", description: "MIME type" },
          filename: { type: "string", description: "Filename (auto-detected from file_path)" },
          caption: { type: "string", description: "Optional caption" },
        },
        required: ["to"],
      },
    },
    {
      name: "wahooks_send_video",
      description: "Send a video via WhatsApp. Provide url, file_path (local file), or data (base64).",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Recipient" },
          url: { type: "string", description: "Video URL" },
          file_path: { type: "string", description: "Local file path" },
          data: { type: "string", description: "Base64-encoded video data" },
          mimetype: { type: "string", description: "MIME type" },
          caption: { type: "string", description: "Optional caption" },
        },
        required: ["to"],
      },
    },
    {
      name: "wahooks_send_audio",
      description: "Send an audio/voice message via WhatsApp. Provide url, file_path (local file), or data (base64).",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Recipient" },
          url: { type: "string", description: "Audio URL" },
          file_path: { type: "string", description: "Local file path" },
          data: { type: "string", description: "Base64-encoded audio data" },
          mimetype: { type: "string", description: "MIME type" },
        },
        required: ["to"],
      },
    },
    {
      name: "wahooks_send_location",
      description: "Send a location pin via WhatsApp.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Phone number" },
          latitude: { type: "number", description: "Latitude" },
          longitude: { type: "number", description: "Longitude" },
          name: { type: "string", description: "Location name" },
          address: { type: "string", description: "Address" },
        },
        required: ["to", "latitude", "longitude"],
      },
    },
    {
      name: "wahooks_send_contact",
      description: "Send a contact card via WhatsApp.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Phone number" },
          contact_name: { type: "string", description: "Contact's display name" },
          contact_phone: { type: "string", description: "Contact's phone number" },
        },
        required: ["to", "contact_name", "contact_phone"],
      },
    },
    {
      name: "wahooks_schedule_reminder",
      description: "Schedule a reminder to perform a task at a specific time. The task will be delivered as a channel event when it's due.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task: { type: "string", description: "What to do when the reminder fires (e.g. 'Read top HN stories and send a briefing')" },
          chat_id: { type: "string", description: "Chat ID to send results to (from the channel tag 'from' attribute)" },
          schedule: { type: "string", description: "Cron expression (e.g. '0 8 * * 1-5' for 8am weekdays, '30 9 * * *' for 9:30am daily)" },
          one_time: { type: "boolean", description: "If true, fires once then auto-deletes. Default: false (recurring)." },
        },
        required: ["task", "chat_id", "schedule"],
      },
    },
    {
      name: "wahooks_list_reminders",
      description: "List all active scheduled reminders.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "wahooks_cancel_reminder",
      description: "Cancel a scheduled reminder by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          reminder_id: { type: "string", description: "Reminder ID to cancel" },
        },
        required: ["reminder_id"],
      },
    },
  ],
}));

function toChatId(id: string): string {
  // Already a full chat ID (contains @)
  if (id.includes("@")) return id;
  // LID format (long numeric, typically 14+ digits used by WhatsApp linked IDs)
  if (id.length >= 14) return `${id}@lid`;
  // Regular phone number
  return `${id.replace(/\D/g, "")}@s.whatsapp.net`;
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments as Record<string, string>;

  switch (req.params.name) {
    case "wahooks_reply":
    case "wahooks_send": {
      const chatId = toChatId(args.to);
      // Human-like: typing → random delay → stop typing → send
      await api("POST", `/connections/${connectionId}/typing`, { chatId }).catch(() => {});
      const delay = 1000 + Math.random() * 2000 + Math.min(args.text.length * 40, 4000);
      await new Promise((r) => setTimeout(r, delay));
      await api("POST", `/connections/${connectionId}/typing/stop`, { chatId }).catch(() => {});
      const sendBody: Record<string, unknown> = {
        chatId,
        text: args.text,
        skipPresence: true,
      };
      if (args.reply_to) sendBody.replyTo = args.reply_to;
      await api("POST", `/connections/${connectionId}/send`, sendBody);
      return { content: [{ type: "text" as const, text: `Sent to ${args.to}` }] };
    }

    case "wahooks_react": {
      const chatId = toChatId(args.to);
      const reaction = args.reaction ?? args.emoji ?? "👍";
      await api("POST", `/connections/${connectionId}/react`, {
        chatId,
        messageId: args.message_id,
        reaction,
      });
      return { content: [{ type: "text" as const, text: `Reacted ${reaction} to message` }] };
    }

    case "wahooks_send_image":
    case "wahooks_send_document":
    case "wahooks_send_video":
    case "wahooks_send_audio": {
      const chatId = toChatId(args.to);
      const media = resolveMedia(args);
      const endpoint = req.params.name.replace("wahooks_", "").replace("_", "-");

      // Human-like: typing → delay → stop typing → send (skipPresence to avoid API doubling)
      await api("POST", `/connections/${connectionId}/typing`, { chatId }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
      await api("POST", `/connections/${connectionId}/typing/stop`, { chatId }).catch(() => {});

      await api("POST", `/connections/${connectionId}/${endpoint}`, {
        chatId,
        ...media,
        caption: args.caption,
        filename: args.filename,
        skipPresence: true,
      });

      const type = endpoint.replace("send-", "");
      return { content: [{ type: "text" as const, text: `${type} sent to ${args.to}` }] };
    }

    case "wahooks_send_location": {
      await api("POST", `/connections/${connectionId}/send-location`, {
        chatId: toChatId(args.to),
        latitude: parseFloat(args.latitude),
        longitude: parseFloat(args.longitude),
        name: args.name,
        address: args.address,
      });
      return { content: [{ type: "text" as const, text: `Location sent to ${args.to}` }] };
    }

    case "wahooks_send_contact": {
      await api("POST", `/connections/${connectionId}/send-contact`, {
        chatId: toChatId(args.to),
        contactName: args.contact_name,
        contactPhone: args.contact_phone,
      });
      return { content: [{ type: "text" as const, text: `Contact sent to ${args.to}` }] };
    }

    case "wahooks_schedule_reminder": {
      const id = `rem_${Date.now().toString(36)}`;
      const oneTime = args.one_time === "true";

      // Calculate next run
      let nextRunAt: string;
      try {
        const cronParser = await import("cron-parser");
        const parseExpression = cronParser.default?.parseExpression ?? cronParser.parseExpression;
        const interval = parseExpression(args.schedule);
        nextRunAt = interval.next().toDate().toISOString();
      } catch {
        return { content: [{ type: "text" as const, text: `Invalid cron expression: ${args.schedule}` }] };
      }

      const reminder: Reminder = {
        id,
        task: args.task,
        chatId: args.chat_id,
        schedule: args.schedule,
        oneTime,
        createdAt: new Date().toISOString(),
        lastFiredAt: null,
        nextRunAt,
      };

      const reminders = readReminders();
      reminders[id] = reminder;
      writeReminders(reminders);

      console.error(`[wahooks-channel] Scheduled reminder ${id}: ${args.task.slice(0, 60)} (${args.schedule})`);
      return { content: [{ type: "text" as const, text: `Reminder scheduled: ${id}\nTask: ${args.task}\nSchedule: ${args.schedule}\nNext run: ${nextRunAt}\nOne-time: ${oneTime}` }] };
    }

    case "wahooks_list_reminders": {
      const reminders = readReminders();
      const entries = Object.values(reminders);
      if (entries.length === 0) {
        return { content: [{ type: "text" as const, text: "No active reminders." }] };
      }
      const list = entries.map((r) =>
        `${r.id}: "${r.task}" — ${r.schedule} (next: ${r.nextRunAt}, ${r.oneTime ? "one-time" : "recurring"})`
      ).join("\n");
      return { content: [{ type: "text" as const, text: `Active reminders:\n${list}` }] };
    }

    case "wahooks_cancel_reminder": {
      const reminders = readReminders();
      const id = args.reminder_id;
      if (!reminders[id]) {
        return { content: [{ type: "text" as const, text: `Reminder ${id} not found.` }] };
      }
      delete reminders[id];
      writeReminders(reminders);
      console.error(`[wahooks-channel] Cancelled reminder ${id}`);
      return { content: [{ type: "text" as const, text: `Reminder ${id} cancelled.` }] };
    }

    default:
      throw new Error(`Unknown tool: ${req.params.name}`);
  }
});

// ─── WebSocket event stream ─────────────────────────────────────────────

function connectWebSocket() {
  const wsProtocol = API_URL.startsWith("https") ? "wss" : "ws";
  const wsHost = API_URL.replace(/^https?/, wsProtocol);
  const wsUrl = `${wsHost}/api/ws?token=${encodeURIComponent(API_KEY)}`;

  console.error("[wahooks-channel] Connecting to event stream...");

  const ws = new WebSocket(wsUrl);
  let alive = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  ws.on("open", () => {
    console.error("[wahooks-channel] Connected to event stream");
    alive = true;

    // Heartbeat: ping every 30s, if no pong within 10s, force reconnect
    heartbeat = setInterval(() => {
      if (!alive) {
        console.error("[wahooks-channel] Heartbeat timeout, reconnecting...");
        clearInterval(heartbeat);
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 30000);
  });

  ws.on("pong", () => {
    alive = true;
  });

  ws.on("message", async (data: WebSocket.RawData) => {
    try {
      const event = JSON.parse(data.toString());
      const eventType: string = event.event ?? "";
      const payload = event.payload ?? {};

      // Only handle "message" events (skip "message.any", "message.ack" to avoid duplicates)
      if (eventType !== "message") return;

      // Skip outbound messages (sent by us)
      if (payload.fromMe) return;

      const chatId: string = payload.from ?? "";
      const isGroup = chatId.includes("@g.us");
      const sender: string = payload.participant ?? chatId;

      // Send read receipt immediately
      if (chatId && connectionId) {
        api("POST", `/connections/${connectionId}/mark-read`, { chatId }).catch(() => {});
      }
      const text: string = payload.body ?? payload.text ?? "";
      const hasMedia: boolean = payload.hasMedia === true;
      const media = payload.media as { url?: string; mimetype?: string } | undefined;
      const messageId: string =
        payload.id?._serialized ?? payload.id ?? `msg_${Date.now()}`;

      if (!chatId || (!text && !hasMedia)) return;

      // Sender gating (check the actual sender, not the group)
      const bareNumber = sender.replace(/@.*$/, "");
      if (ALLOW_LIST.size > 0 && !ALLOW_LIST.has(bareNumber)) {
        console.error(`[wahooks-channel] Blocked message from ${sender} (not in allow list)`);
        return;
      }

      // Track last sender for replies
      lastSender = chatId; // reply to the chat (group or DM)

      // Check if this is a permission verdict
      const permMatch = PERMISSION_RE.exec(text);
      if (permMatch) {
        await mcp.notification({
          method: "notifications/claude/channel/permission",
          params: {
            request_id: permMatch[2].toLowerCase(),
            behavior: permMatch[1].toLowerCase().startsWith("y") ? "allow" : "deny",
          },
        });
        console.error(`[wahooks-channel] Permission verdict: ${permMatch[1]} ${permMatch[2]}`);
        return;
      }

      // Build message content for Claude
      let content = text;
      let localMediaPath = "";
      if (hasMedia && media?.url) {
        const mime = media.mimetype ?? "unknown";
        // Download media locally so Claude can access it directly
        try {
          const mediaRes = await fetch(media.url, {
            headers: { Authorization: `Bearer ${API_KEY}` },
          });
          if (mediaRes.ok) {
            const buf = Buffer.from(await mediaRes.arrayBuffer());
            const ext = mime.split("/")[1]?.split(";")[0] ?? "bin";
            localMediaPath = path.join(os.tmpdir(), `wahooks-media-${Date.now()}.${ext}`);
            fs.writeFileSync(localMediaPath, buf);
            content = `${text ? text + "\n\n" : ""}[Attached: ${mime}] Saved to: ${localMediaPath}`;
            console.error(`[wahooks-channel] Media saved: ${localMediaPath} (${buf.length} bytes)`);
          } else {
            content = `${text ? text + "\n\n" : ""}[Attached: ${mime}] (could not download)`;
          }
        } catch (err) {
          content = `${text ? text + "\n\n" : ""}[Attached: ${mime}] (download failed)`;
          console.error(`[wahooks-channel] Media download failed: ${err}`);
        }
      }

      // Forward to Claude Code
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content,
          meta: {
            from: chatId,
            sender: isGroup ? sender : chatId,
            message_id: messageId,
            ...(isGroup ? { group: "true" } : {}),
            ...(hasMedia ? { has_media: "true", media_type: media?.mimetype ?? "unknown" } : {}),
          },
        },
      });

      console.error(`[wahooks-channel] ${isGroup ? "[group] " : ""}Message from ${sender}: ${text.slice(0, 80)}${hasMedia ? " [+media]" : ""}`);
    } catch (err) {
      console.error("[wahooks-channel] Event parse error:", err);
    }
  });

  ws.on("close", (code: number) => {
    if (heartbeat) clearInterval(heartbeat);
    console.error(`[wahooks-channel] Connection closed (${code}), reconnecting in 5s...`);
    setTimeout(connectWebSocket, 5000);
  });

  ws.on("error", (err: Error) => {
    console.error(`[wahooks-channel] WebSocket error: ${err.message}`);
    // close event will fire after this and trigger reconnect
  });
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  connectionId = await resolveConnection();
  console.error(`[wahooks-channel] Using connection: ${connectionId}`);

  // Start MCP transport with connection tracking
  const transport = new StdioServerTransport();

  transport.onclose = () => {
    claudeConnected = false;
    console.error("[wahooks-channel] Claude disconnected");
  };

  await mcp.connect(transport);
  claudeConnected = true;

  // Connect to real-time event stream
  connectWebSocket();

  // Process any pending reminders immediately
  await processPendingQueue();

  // Watch pending.json for changes (daemon writes to it)
  fs.mkdirSync(WAHOOKS_DIR, { recursive: true });
  // Ensure file exists for watching
  if (!fs.existsSync(PENDING_FILE)) {
    fs.writeFileSync(PENDING_FILE, "[]", { mode: 0o600 });
  }

  // Use both fs.watch and polling for robustness
  try {
    fs.watch(PENDING_FILE, () => {
      setTimeout(() => processPendingQueue(), 500); // debounce
    });
  } catch {
    // fs.watch not supported — fall back to polling only
  }
  // Poll every 10s as fallback
  setInterval(() => processPendingQueue(), 10_000);

  console.error("[wahooks-channel] Ready — WhatsApp messages will appear in Claude Code");
}

main().catch((err) => {
  console.error("[wahooks-channel] Fatal:", err.message);
  process.exit(1);
});
