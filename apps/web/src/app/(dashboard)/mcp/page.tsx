"use client";

import { CopyButton } from "@/components/copy-button";
import Link from "next/link";

const claudeDesktopConfig = `{
  "mcpServers": {
    "wahooks": {
      "url": "https://api.wahooks.com/mcp"
    }
  }
}`;

const claudeCodeCommand = "claude mcp add wahooks https://api.wahooks.com/mcp";
const mcpUrl = "https://api.wahooks.com/mcp";

function CodeBlock({ code, copyText }: { code: string; copyText?: string }) {
  return (
    <div className="relative mt-2 rounded-lg border border-border-primary bg-bg-elevated px-3 py-2.5">
      <pre className="overflow-x-auto pr-8 text-sm text-text-primary font-mono whitespace-pre">
        {code}
      </pre>
      <div className="absolute right-1.5 top-1.5">
        <CopyButton text={copyText ?? code} />
      </div>
    </div>
  );
}

export default function McpPage() {
  return (
    <div className="animate-fade-in">
      <h1 className="text-2xl font-bold text-text-primary">MCP Server</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Connect WAHooks to AI assistants like Claude, ChatGPT, and Cursor.
      </p>

      <div className="mt-5 space-y-3">
        {/* Claude Desktop */}
        <div className="rounded-xl border border-border-primary bg-bg-secondary p-5 transition-colors duration-150 hover:border-border-secondary">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-primary bg-bg-elevated text-lg">
              <svg className="h-5 w-5 text-text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h2 className="text-base font-semibold text-text-primary">
              Claude Desktop
            </h2>
          </div>
          <p className="mt-2 text-sm text-text-secondary">
            Add this to your{" "}
            <code className="rounded bg-bg-elevated px-1.5 py-0.5 text-xs font-mono text-text-primary">
              ~/.claude/claude_desktop_config.json
            </code>
          </p>
          <CodeBlock code={claudeDesktopConfig} />
        </div>

        {/* Claude Code */}
        <div className="rounded-xl border border-border-primary bg-bg-secondary p-5 transition-colors duration-150 hover:border-border-secondary">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-primary bg-bg-elevated text-lg">
              <svg className="h-5 w-5 text-text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <h2 className="text-base font-semibold text-text-primary">
              Claude Code
            </h2>
          </div>
          <p className="mt-2 text-sm text-text-secondary">
            Run this command in your terminal:
          </p>
          <CodeBlock code={claudeCodeCommand} />
        </div>

        {/* Cursor */}
        <div className="rounded-xl border border-border-primary bg-bg-secondary p-5 transition-colors duration-150 hover:border-border-secondary">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-primary bg-bg-elevated text-lg">
              <svg className="h-5 w-5 text-text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <h2 className="text-base font-semibold text-text-primary">
              Cursor
            </h2>
          </div>
          <p className="mt-2 text-sm text-text-secondary">
            Go to Settings &rarr; MCP &rarr; Add server, then paste the URL:
          </p>
          <CodeBlock code={mcpUrl} />
        </div>

        {/* Local Mode */}
        <div className="rounded-xl border border-border-primary bg-bg-secondary p-5 transition-colors duration-150 hover:border-border-secondary">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-primary bg-bg-elevated text-lg">
              <svg className="h-5 w-5 text-text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
            <h2 className="text-base font-semibold text-text-primary">
              Local Mode (API Key)
            </h2>
          </div>
          <p className="mt-2 text-sm text-text-secondary">
            Install and run the MCP server locally with your API key:
          </p>
          <CodeBlock code="pip install wahooks-mcp" />
          <CodeBlock code="WAHOOKS_API_KEY=wh_... wahooks-mcp" />
          <p className="mt-2 text-sm text-text-tertiary">
            You will need an API token.{" "}
            <Link
              href="/tokens"
              className="text-wa-green transition-colors duration-150 hover:underline"
            >
              Create one here
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
