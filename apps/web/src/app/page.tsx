"use client";

import Link from "next/link";
import { useState } from "react";
import { usePricing } from "@/lib/pricing";

function CopySnippet({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="group mx-auto mt-12 flex max-w-md items-center gap-3 rounded-lg border border-border-primary bg-bg-secondary/60 px-5 py-3 font-mono text-sm text-text-secondary backdrop-blur-sm transition-colors hover:border-border-secondary hover:bg-bg-secondary"
    >
      <span className="flex-1 text-left">
        <span className="text-text-tertiary">$</span> {text}
      </span>
      <span className="shrink-0 text-text-tertiary transition-colors group-hover:text-text-secondary">
        {copied ? (
          <svg className="h-4 w-4 text-wa-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
        ) : (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
        )}
      </span>
    </button>
  );
}

export default function Home() {
  const pricing = usePricing();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="relative min-h-screen bg-bg-primary">
      {/* Grid background */}
      <div
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "80px 80px",
        }}
      />

      {/* Gradient glow behind hero */}
      <div className="pointer-events-none fixed inset-0 z-0 flex items-start justify-center">
        <div className="mt-32 h-[600px] w-[800px] rounded-full bg-wa-green/[0.04] blur-[120px]" />
      </div>

      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border-primary bg-bg-primary/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <img src="/logo.svg" alt="" className="h-7 w-7" />
            <span className="text-xl font-bold text-wa-green">WAHooks</span>
          </Link>

          {/* Desktop nav */}
          <div className="hidden items-center gap-5 sm:flex">
            <Link href="/docs" className="text-sm font-medium text-text-tertiary hover:text-text-primary transition-colors">
              Docs
            </Link>
            <Link href="/login" className="text-sm font-medium text-text-tertiary hover:text-text-primary transition-colors">
              Sign in
            </Link>
            <a
              href="https://github.com/dhruvyad/wahooks"
              className="rounded-lg border border-border-primary p-2 text-text-tertiary hover:text-text-primary hover:border-border-secondary transition-colors"
              aria-label="GitHub"
            >
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>
            </a>
            <Link href="/signup" className="rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse hover:bg-wa-green-dark transition-colors">
              Get Started
            </Link>
          </div>

          {/* Mobile hamburger */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="sm:hidden rounded-lg p-2 text-text-tertiary hover:text-text-primary transition-colors"
            aria-label="Menu"
          >
            {mobileMenuOpen ? (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            ) : (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
            )}
          </button>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="border-t border-border-primary bg-bg-secondary/95 backdrop-blur-xl px-6 py-5 space-y-1 sm:hidden">
            <Link href="/docs" onClick={() => setMobileMenuOpen(false)} className="block rounded-lg px-3 py-2.5 text-sm font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors">
              Docs
            </Link>
            <a href="https://github.com/dhruvyad/wahooks" className="block rounded-lg px-3 py-2.5 text-sm font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors">
              GitHub
            </a>
            <Link href="/login" onClick={() => setMobileMenuOpen(false)} className="block rounded-lg px-3 py-2.5 text-sm font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors">
              Sign in
            </Link>
            <div className="pt-2">
              <Link href="/signup" onClick={() => setMobileMenuOpen(false)} className="block rounded-lg bg-wa-green px-4 py-2.5 text-center text-sm font-semibold text-text-inverse hover:bg-wa-green-dark transition-colors">
                Get Started
              </Link>
            </div>
          </div>
        )}
      </nav>

      {/* Hero */}
      <section className="relative z-10 px-6 py-36">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="text-5xl font-bold leading-[1.1] tracking-tight sm:text-7xl">
            WhatsApp Webhooks,{" "}
            <br className="hidden sm:block" />
            <span className="text-wa-green">Instant Setup</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-text-secondary">
            Connect WhatsApp numbers, receive real-time webhooks, and send
            messages — all through a simple API. No infrastructure to manage.
          </p>
          <p className="mt-3 text-sm text-text-tertiary">
            <a href="https://github.com/dhruvyad/wahooks" className="hover:text-text-secondary transition-colors">
              Fully open source
            </a>
            {" "}&middot;{" "}
            <a href="https://github.com/dhruvyad/wahooks/blob/main/LICENSE" className="text-wa-green hover:underline">
              MIT License
            </a>
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <Link
              href="/signup"
              className="group rounded-lg bg-wa-green px-7 py-3 text-sm font-semibold text-text-inverse transition-all hover:bg-wa-green-dark hover:shadow-lg hover:shadow-wa-green/20"
            >
              Get Started
            </Link>
            <Link
              href="/docs"
              className="rounded-lg border border-border-secondary px-7 py-3 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
            >
              Read the Docs
            </Link>
          </div>

          <CopySnippet text="curl -fsSL wahooks.com/install | bash" />
        </div>
      </section>

      {/* Demo Video */}
      <section className="relative z-10 px-6 pb-20">
        <div className="mx-auto max-w-6xl">
          <div className="overflow-hidden rounded-xl border border-border-primary shadow-2xl shadow-black/20">
            <video
              autoPlay
              loop
              muted
              playsInline
              className="w-full"
            >
              <source src="/demo.webm" type="video/webm" />
              <source src="/demo.mp4" type="video/mp4" />
            </video>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="relative z-10 border-t border-border-primary px-6 py-28">
        <div className="mx-auto max-w-6xl">
          <p className="text-center text-xs font-semibold uppercase tracking-widest text-wa-green">
            How it works
          </p>
          <h2 className="mt-3 text-center text-3xl font-bold">
            Three steps to WhatsApp webhooks
          </h2>
          <div className="mt-16 grid gap-6 sm:grid-cols-3">
            {[
              {
                step: "01",
                title: "Connect Your Number",
                description:
                  "Create a connection and scan the QR code with WhatsApp to link your number.",
              },
              {
                step: "02",
                title: "Configure Webhooks",
                description:
                  "Set your endpoint URL and choose which events to receive — messages, status changes, and more.",
              },
              {
                step: "03",
                title: "Start Building",
                description:
                  "Use the SDK, CLI, or REST API to send messages and process incoming events in real time.",
              },
            ].map((item) => (
              <div
                key={item.step}
                className="group rounded-xl border border-border-primary bg-bg-secondary/50 p-6 backdrop-blur-sm transition-all duration-200 hover:border-border-secondary hover:bg-bg-secondary"
              >
                <span className="font-mono text-xs text-wa-green/60">
                  {item.step}
                </span>
                <h3 className="mt-3 text-lg font-semibold text-text-primary">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section
        id="features"
        className="relative z-10 border-t border-border-primary px-6 py-28"
      >
        <div className="mx-auto max-w-6xl">
          <p className="text-center text-xs font-semibold uppercase tracking-widest text-wa-green">
            Platform
          </p>
          <h2 className="mt-3 text-center text-3xl font-bold">
            Everything You Need
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-text-secondary">
            A complete platform for WhatsApp integration.
          </p>
          <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                title: "Managed Infrastructure",
                description:
                  "Cloud-hosted WAHA containers with automatic scaling and health monitoring. Zero DevOps.",
              },
              {
                title: "Persistent Sessions",
                description:
                  "WhatsApp auth state persisted in Postgres. Sessions survive restarts, updates, and node replacements.",
              },
              {
                title: "Webhook Delivery",
                description:
                  "HMAC-SHA256 signed payloads with exponential backoff (5 retries) and a dead-letter queue.",
              },
              {
                title: "SDKs & CLI",
                description:
                  "TypeScript and Python SDKs, a full-featured CLI, and API tokens for programmatic access.",
              },
              {
                title: "MCP Server",
                description:
                  "Connect AI agents to WhatsApp. Works with Claude, Cursor, Windsurf, and any MCP-compatible assistant.",
              },
              {
                title: "Secure by Default",
                description:
                  "Encrypted API keys, private network isolation, OAuth authentication, and signed webhooks.",
              },
            ].map((feature) => (
              <div
                key={feature.title}
                className="rounded-xl border border-border-primary bg-bg-secondary/50 p-6 backdrop-blur-sm transition-all duration-200 hover:border-border-secondary hover:bg-bg-secondary"
              >
                <h3 className="text-sm font-semibold text-text-primary">
                  {feature.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="relative z-10 border-t border-border-primary px-6 py-28">
        <div className="mx-auto max-w-6xl">
          <p className="text-center text-xs font-semibold uppercase tracking-widest text-wa-green">
            Pricing
          </p>
          <h2 className="mt-3 text-center text-3xl font-bold">
            Simple and Transparent
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-text-secondary">
            No subscriptions. No hidden fees. Pay for what you use.
          </p>
          <div className="mx-auto mt-16 max-w-sm rounded-xl border border-border-secondary bg-bg-secondary/60 p-8 text-center backdrop-blur-sm">
            <p className="text-5xl font-bold text-wa-green">{pricing.label}</p>
            <p className="mt-2 text-text-secondary">per connection / month</p>
            <ul className="mx-auto mt-8 w-fit space-y-3 text-left text-sm text-text-secondary">
              {[
                "Simple monthly billing per connection",
                "Unlimited webhooks per connection",
                "Automatic retries with exponential backoff",
                "HMAC-SHA256 signed deliveries",
                "Full event logs and delivery tracking",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <span className="mt-0.5 text-wa-green">&#10003;</span>
                  {item}
                </li>
              ))}
            </ul>
            <Link
              href="/signup"
              className="mt-8 inline-block rounded-lg bg-wa-green px-8 py-3 text-sm font-semibold text-text-inverse transition-all hover:bg-wa-green-dark hover:shadow-lg hover:shadow-wa-green/20"
            >
              Start Building
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border-primary px-6 py-8">
        <div className="mx-auto max-w-6xl flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-wa-green">
            <img src="/logo.svg" alt="" className="h-5 w-5" />
            WAHooks
          </span>
          <div className="flex items-center gap-5">
            <Link
              href="/docs"
              className="text-sm text-text-tertiary hover:text-text-primary transition-colors"
            >
              Docs
            </Link>
            <a
              href="https://discord.gg/B2XNf97Vby"
              className="text-sm text-text-tertiary hover:text-text-primary transition-colors"
            >
              Discord
            </a>
            <a
              href="https://github.com/dhruvyad/wahooks"
              className="text-sm text-text-tertiary hover:text-text-primary transition-colors"
            >
              GitHub
            </a>
            <Link
              href="/terms"
              className="text-sm text-text-tertiary hover:text-text-primary transition-colors"
            >
              Terms
            </Link>
            <Link
              href="/privacy"
              className="text-sm text-text-tertiary hover:text-text-primary transition-colors"
            >
              Privacy
            </Link>
            <span className="text-sm text-text-tertiary">
              &copy; {new Date().getFullYear()}
            </span>
          </div>
        </div>
        <p className="mt-4 text-center text-xs text-text-tertiary sm:mt-0">
          brought to you by{" "}
          <a
            href="https://x.com/dhruvyad"
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-secondary hover:text-text-primary transition-colors"
          >
            @dhruvyad
          </a>
        </p>
      </footer>
    </div>
  );
}
