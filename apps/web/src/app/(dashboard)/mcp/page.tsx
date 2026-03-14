"use client";

import { CopyButton } from "@/components/copy-button";
import Link from "next/link";

const mcpUrl = "https://api.wahooks.com/mcp";

function CodeBlock({ code, copyText, lang }: { code: string; copyText?: string; lang?: string }) {
  return (
    <div className="group relative mt-1.5 rounded-md bg-bg-primary/60 border border-border-primary">
      {lang && (
        <div className="px-3 pt-1.5 text-[10px] font-mono uppercase text-text-tertiary">{lang}</div>
      )}
      <pre className="overflow-x-auto px-3 py-2 pr-10 text-[13px] text-text-primary font-mono leading-relaxed whitespace-pre">
        {code}
      </pre>
      <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton text={copyText ?? code} />
      </div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-8">
      <h2 className="text-base font-semibold text-text-primary border-b border-border-primary pb-2 mb-3">{title}</h2>
      <div className="space-y-2 text-sm text-text-secondary">{children}</div>
    </div>
  );
}

export default function McpPage() {
  return (
    <div className="animate-fade-in max-w-2xl">
      <h1 className="text-2xl font-bold text-text-primary">MCP Server</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Connect WAHooks to Claude Code, Cursor, Windsurf, or any MCP-compatible AI assistant.
        Your assistant can manage WhatsApp connections, send messages, and configure webhooks.
      </p>

      <div className="mt-6 space-y-6">
        <Section id="claude-code" title="Claude Code">
          <p>Add to <code className="rounded bg-bg-elevated px-1 py-0.5 text-xs font-mono text-text-tertiary">.mcp.json</code> in your project root:</p>
          <CodeBlock lang="json" code={`{
  "mcpServers": {
    "wahooks": {
      "type": "http",
      "url": "${mcpUrl}"
    }
  }
}`} />
          <p className="mt-2">Or use the CLI:</p>
          <CodeBlock lang="bash" code={`claude mcp add --transport http wahooks ${mcpUrl}`} />
          <p className="mt-2 text-xs text-text-tertiary">
            On first use, your browser will open to authenticate with your WAHooks account.
          </p>
        </Section>

        <Section id="cursor" title="Cursor">
          <p>Add to <code className="rounded bg-bg-elevated px-1 py-0.5 text-xs font-mono text-text-tertiary">.cursor/mcp.json</code> in your project root:</p>
          <CodeBlock lang="json" code={`{
  "mcpServers": {
    "wahooks": {
      "url": "${mcpUrl}"
    }
  }
}`} />
          <p className="mt-2 text-xs text-text-tertiary">Restart Cursor after saving. A browser window will open for OAuth on first tool use.</p>
        </Section>

        <Section id="windsurf" title="Windsurf">
          <p>Add to your Windsurf MCP config:</p>
          <ul className="text-xs text-text-tertiary list-disc list-inside">
            <li><strong>macOS/Linux:</strong> <code className="font-mono">~/.codeium/windsurf/mcp_config.json</code></li>
            <li><strong>Windows:</strong> <code className="font-mono">%USERPROFILE%\.codeium\windsurf\mcp_config.json</code></li>
          </ul>
          <CodeBlock lang="json" code={`{
  "mcpServers": {
    "wahooks": {
      "serverUrl": "${mcpUrl}"
    }
  }
}`} />
          <p className="mt-1.5 text-xs text-status-warning-text">
            Note: Windsurf uses <code className="font-mono">serverUrl</code> (not <code className="font-mono">url</code>).
          </p>
        </Section>

        <Section id="claude-desktop" title="Claude Desktop">
          <p>Claude Desktop uses stdio-based servers. Use the <code className="rounded bg-bg-elevated px-1 py-0.5 text-xs font-mono text-text-tertiary">mcp-remote</code> wrapper:</p>
          <ul className="text-xs text-text-tertiary list-disc list-inside">
            <li><strong>macOS:</strong> <code className="font-mono">~/Library/Application Support/Claude/claude_desktop_config.json</code></li>
            <li><strong>Windows:</strong> <code className="font-mono">%APPDATA%\Claude\claude_desktop_config.json</code></li>
          </ul>
          <CodeBlock lang="json" code={`{
  "mcpServers": {
    "wahooks": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${mcpUrl}"]
    }
  }
}`} />
          <p className="mt-1.5 text-xs text-text-tertiary">Fully quit and restart Claude Desktop after editing.</p>
        </Section>

        <Section id="local" title="Local Mode (API Key)">
          <p>
            Run the MCP server locally with your{" "}
            <Link href="/tokens" className="text-wa-green hover:underline">API token</Link>:
          </p>
          <CodeBlock lang="bash" code="pip install wahooks-mcp" />
          <CodeBlock lang="bash" code="WAHOOKS_API_KEY=wh_... wahooks-mcp" />
        </Section>

        <Section id="verify" title="Verify">
          <p>Ask your AI assistant:</p>
          <CodeBlock code="List my WAHooks connections" />
          <p className="mt-1.5 text-xs text-text-tertiary">
            If tools don&apos;t show up, restart your assistant and check the config file syntax.
          </p>
        </Section>
      </div>
    </div>
  );
}
