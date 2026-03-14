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
    <div className="group relative mt-1.5 rounded-md bg-bg-primary/60 border border-border-primary">
      <pre className="overflow-x-auto px-3 py-2 pr-10 text-[13px] text-text-primary font-mono leading-relaxed whitespace-pre">
        {code}
      </pre>
      <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton text={copyText ?? code} />
      </div>
    </div>
  );
}

function Card({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border-primary bg-bg-secondary p-4 transition-colors duration-150 hover:border-border-secondary">
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-bg-elevated text-text-secondary">
          {icon}
        </div>
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      </div>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

export default function McpPage() {
  return (
    <div className="animate-fade-in max-w-2xl">
      <h1 className="text-2xl font-bold text-text-primary">MCP Server</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Connect WAHooks to AI assistants. Just add the server URL and authenticate.
      </p>

      <div className="mt-4 space-y-2.5">
        <Card
          icon={
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          }
          title="Claude Desktop"
        >
          <p className="text-xs text-text-secondary">
            Add to{" "}
            <code className="rounded bg-bg-elevated px-1 py-0.5 text-[11px] font-mono text-text-tertiary">
              ~/.claude/claude_desktop_config.json
            </code>
          </p>
          <CodeBlock code={claudeDesktopConfig} />
        </Card>

        <Card
          icon={
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          }
          title="Claude Code"
        >
          <p className="text-xs text-text-secondary">Run in your terminal:</p>
          <CodeBlock code={claudeCodeCommand} />
        </Card>

        <Card
          icon={
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          }
          title="Cursor"
        >
          <p className="text-xs text-text-secondary">
            Settings → MCP → Add server
          </p>
          <CodeBlock code={mcpUrl} />
        </Card>

        <Card
          icon={
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
          }
          title="Local Mode (API Key)"
        >
          <p className="text-xs text-text-secondary">
            Run locally with your{" "}
            <Link href="/tokens" className="text-wa-green hover:underline">
              API token
            </Link>
          </p>
          <CodeBlock code="pip install wahooks-mcp" />
          <CodeBlock code="WAHOOKS_API_KEY=wh_... wahooks-mcp" />
        </Card>
      </div>
    </div>
  );
}
