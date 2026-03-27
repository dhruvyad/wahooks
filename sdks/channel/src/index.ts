#!/usr/bin/env node
/**
 * @wahooks/channel — WhatsApp channel for Claude Code
 *
 * Connects WhatsApp to a running Claude Code session via WAHooks.
 * Messages from WhatsApp appear as <channel> events; Claude replies
 * via the reply tool and messages are sent back through WhatsApp.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:wahooks-channel
 *
 * Environment:
 *   WAHOOKS_API_KEY     — WAHooks API token (wh_...)
 *   WAHOOKS_API_URL     — API base URL (default: https://api.wahooks.com)
 *   WAHOOKS_CONNECTION  — Connection ID to use (auto-detected if only one)
 *   WAHOOKS_ALLOW       — Comma-separated phone numbers to accept (empty = all)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";

// ─── Config ─────────────────────────────────────────────────────────────

const API_KEY = process.env.WAHOOKS_API_KEY ?? "";
const API_URL = (process.env.WAHOOKS_API_URL ?? "https://api.wahooks.com").replace(/\/$/, "");
const CONNECTION_ID = process.env.WAHOOKS_CONNECTION ?? "";
const ALLOW_LIST = new Set(
  (process.env.WAHOOKS_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\D/g, ""))
    .filter(Boolean)
);
const WEBHOOK_PORT = parseInt(process.env.WAHOOKS_CHANNEL_PORT ?? "8790", 10);

if (!API_KEY) {
  console.error("[wahooks-channel] WAHOOKS_API_KEY is required");
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

// Track inbound message → sender mapping for replies
const messageToSender = new Map<string, string>();

// ─── MCP Server ─────────────────────────────────────────────────────────

const mcp = new Server(
  { name: "wahooks-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "WhatsApp messages arrive as <channel source=\"wahooks-channel\" from=\"phone\" message_id=\"id\">.",
      "Use the wahooks_reply tool to send responses back. Pass the from phone number.",
      "Use wahooks_send_image / wahooks_send_document to send media.",
      "You can also proactively message any phone with wahooks_send.",
    ].join(" "),
  }
);

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

    default:
      throw new Error(`Unknown tool: ${req.params.name}`);
  }
});

// ─── Webhook receiver ───────────────────────────────────────────────────

function startWebhookServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk; });
    req.on("end", async () => {
      try {
        const event = JSON.parse(body);

        // WAHooks webhook payload structure
        const eventType: string = event.event ?? "";
        const payload = event.payload ?? {};

        // Only handle incoming messages
        if (!eventType.startsWith("message")) {
          res.writeHead(200);
          res.end("ok");
          return;
        }

        const from: string = (payload.from ?? "").replace("@c.us", "").replace("@s.whatsapp.net", "");
        const text: string = payload.body ?? payload.text ?? "";
        const messageId: string = payload.id?._serialized ?? payload.id ?? `msg_${Date.now()}`;

        if (!from || !text) {
          res.writeHead(200);
          res.end("ok");
          return;
        }

        // Sender gating
        if (ALLOW_LIST.size > 0 && !ALLOW_LIST.has(from)) {
          console.error(`[wahooks-channel] Blocked message from ${from} (not in allow list)`);
          res.writeHead(200);
          res.end("ok");
          return;
        }

        // Track sender for replies
        messageToSender.set(messageId, from);

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
        res.writeHead(200);
        res.end("ok");
      } catch (err) {
        console.error("[wahooks-channel] Webhook error:", err);
        res.writeHead(500);
        res.end("error");
      }
    });
  });

  server.listen(WEBHOOK_PORT, "127.0.0.1", () => {
    console.error(`[wahooks-channel] Webhook server listening on http://127.0.0.1:${WEBHOOK_PORT}`);
    console.error(`[wahooks-channel] Configure WAHooks webhook URL: http://localhost:${WEBHOOK_PORT}/webhook`);
  });
}

// ─── Setup webhook on WAHooks ───────────────────────────────────────────

async function ensureWebhook() {
  try {
    const webhooks = await api<Array<{ id: string; url: string }>>(
      "GET",
      `/connections/${connectionId}/webhooks`
    );

    const localUrl = `http://localhost:${WEBHOOK_PORT}/webhook`;
    const existing = webhooks.find((w) => w.url === localUrl);

    if (!existing) {
      console.error("[wahooks-channel] Note: set up a webhook pointing to this server.");
      console.error(`[wahooks-channel] URL: ${localUrl}`);
      console.error("[wahooks-channel] Events: message, message.any");
    }
  } catch {
    // Non-critical
  }
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  connectionId = await resolveConnection();
  console.error(`[wahooks-channel] Using connection: ${connectionId}`);

  // Start MCP transport
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  // Start webhook receiver
  startWebhookServer();
  await ensureWebhook();

  console.error("[wahooks-channel] Ready — WhatsApp messages will appear in Claude Code");
}

main().catch((err) => {
  console.error("[wahooks-channel] Fatal:", err.message);
  process.exit(1);
});
