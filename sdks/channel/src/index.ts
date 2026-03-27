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
      "WhatsApp messages arrive as <channel source=\"wahooks-channel\" from=\"phone\" message_id=\"id\">.",
      "Use wahooks_reply to respond to the sender. Use wahooks_send to message any phone.",
      "Media tools: wahooks_send_image, wahooks_send_video, wahooks_send_audio, wahooks_send_document.",
      "Also available: wahooks_send_location (lat/lng) and wahooks_send_contact (name/phone).",
      "For permission requests, the user can reply 'yes XXXXX' or 'no XXXXX' where XXXXX is the request ID.",
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
      description: "Reply to a WhatsApp message. Use the 'from' phone number from the channel event.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Phone number to reply to (from the channel tag)" },
          text: { type: "string", description: "Message text" },
        },
        required: ["to", "text"],
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
      description: "Send an image via WhatsApp.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Phone number" },
          url: { type: "string", description: "Image URL" },
          caption: { type: "string", description: "Optional caption" },
        },
        required: ["to", "url"],
      },
    },
    {
      name: "wahooks_send_document",
      description: "Send a document/file via WhatsApp.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Phone number" },
          url: { type: "string", description: "Document URL" },
          filename: { type: "string", description: "Filename" },
        },
        required: ["to", "url"],
      },
    },
    {
      name: "wahooks_send_video",
      description: "Send a video via WhatsApp.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Phone number" },
          url: { type: "string", description: "Video URL" },
          caption: { type: "string", description: "Optional caption" },
        },
        required: ["to", "url"],
      },
    },
    {
      name: "wahooks_send_audio",
      description: "Send an audio/voice message via WhatsApp.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Phone number" },
          url: { type: "string", description: "Audio URL" },
        },
        required: ["to", "url"],
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
  ],
}));

function toChatId(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.includes("@") ? digits : `${digits}@s.whatsapp.net`;
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments as Record<string, string>;

  switch (req.params.name) {
    case "wahooks_reply":
    case "wahooks_send": {
      await api("POST", `/connections/${connectionId}/send`, {
        chatId: toChatId(args.to),
        text: args.text,
      });
      return { content: [{ type: "text" as const, text: `Sent to ${args.to}` }] };
    }

    case "wahooks_send_image": {
      await api("POST", `/connections/${connectionId}/send-image`, {
        chatId: toChatId(args.to),
        url: args.url,
        caption: args.caption,
      });
      return { content: [{ type: "text" as const, text: `Image sent to ${args.to}` }] };
    }

    case "wahooks_send_document": {
      await api("POST", `/connections/${connectionId}/send-document`, {
        chatId: toChatId(args.to),
        url: args.url,
        filename: args.filename,
      });
      return { content: [{ type: "text" as const, text: `Document sent to ${args.to}` }] };
    }

    case "wahooks_send_video": {
      await api("POST", `/connections/${connectionId}/send-video`, {
        chatId: toChatId(args.to),
        url: args.url,
        caption: args.caption,
      });
      return { content: [{ type: "text" as const, text: `Video sent to ${args.to}` }] };
    }

    case "wahooks_send_audio": {
      await api("POST", `/connections/${connectionId}/send-audio`, {
        chatId: toChatId(args.to),
        url: args.url,
      });
      return { content: [{ type: "text" as const, text: `Audio sent to ${args.to}` }] };
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

  ws.on("open", () => {
    console.error("[wahooks-channel] Connected to event stream");
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

      const from: string = (payload.from ?? "")
        .replace("@c.us", "")
        .replace("@s.whatsapp.net", "")
        .replace("@lid", "");
      const text: string = payload.body ?? payload.text ?? "";
      const messageId: string =
        payload.id?._serialized ?? payload.id ?? `msg_${Date.now()}`;

      if (!from || !text) return;

      // Sender gating
      if (ALLOW_LIST.size > 0 && !ALLOW_LIST.has(from)) {
        console.error(`[wahooks-channel] Blocked message from ${from} (not in allow list)`);
        return;
      }

      // Track last sender for permission relay
      lastSender = from;

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

      // Forward to Claude Code
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: text,
          meta: {
            from,
            message_id: messageId,
          },
        },
      });

      console.error(`[wahooks-channel] Message from ${from}: ${text.slice(0, 80)}`);
    } catch (err) {
      console.error("[wahooks-channel] Event parse error:", err);
    }
  });

  ws.on("close", (code: number) => {
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

  // Start MCP transport
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  // Connect to real-time event stream
  connectWebSocket();

  console.error("[wahooks-channel] Ready — WhatsApp messages will appear in Claude Code");
}

main().catch((err) => {
  console.error("[wahooks-channel] Fatal:", err.message);
  process.exit(1);
});
