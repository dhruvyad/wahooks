import Link from "next/link";

export default function Home() {
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
          <div className="flex items-center gap-5">
            <Link
              href="/docs"
              className="text-sm font-medium text-text-tertiary hover:text-text-primary transition-colors"
            >
              Docs
            </Link>
            <Link
              href="/login"
              className="text-sm font-medium text-text-tertiary hover:text-text-primary transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse hover:bg-wa-green-dark transition-colors"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative z-10 px-6 py-36">
        <div className="mx-auto max-w-4xl text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border-primary bg-bg-secondary/60 px-4 py-1.5 text-xs text-text-tertiary backdrop-blur-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-wa-green animate-pulse" />
            Now with WAHA Plus — 50 sessions per node
          </div>
          <h1 className="text-5xl font-bold leading-[1.1] tracking-tight sm:text-7xl">
            WhatsApp Webhooks,{" "}
            <br className="hidden sm:block" />
            <span className="text-wa-green">Instant Setup</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-text-secondary">
            Connect WhatsApp numbers, receive real-time webhooks, and send
            messages — all through a simple API. No infrastructure to manage.
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <Link
              href="/signup"
              className="group rounded-lg bg-wa-green px-7 py-3 text-sm font-semibold text-text-inverse transition-all hover:bg-wa-green-dark hover:shadow-lg hover:shadow-wa-green/20"
            >
              Get Started Free
            </Link>
            <Link
              href="/docs"
              className="rounded-lg border border-border-secondary px-7 py-3 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
            >
              Read the Docs
            </Link>
          </div>

          {/* Install snippet */}
          <div className="mx-auto mt-12 max-w-md">
            <div className="rounded-lg border border-border-primary bg-bg-secondary/60 px-5 py-3 font-mono text-sm text-text-secondary backdrop-blur-sm">
              <span className="text-text-tertiary">$</span>{" "}
              curl -fsSL wahooks.com/install | bash
            </div>
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
                  "TypeScript and Python SDKs, a full CLI, and an MCP server for AI assistants.",
              },
              {
                title: "Usage-Based Pricing",
                description:
                  "Pay $0.25 per connection per month, prorated to the hour. No minimums.",
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
          <div className="mx-auto mt-16 max-w-md rounded-xl border border-border-secondary bg-bg-secondary/60 p-8 text-center backdrop-blur-sm">
            <p className="text-5xl font-bold text-wa-green">$0.25</p>
            <p className="mt-2 text-text-secondary">per connection / month</p>
            <ul className="mt-8 space-y-3 text-left text-sm text-text-secondary">
              {[
                "Prorated hourly — only pay for active time",
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
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-wa-green">
            <img src="/logo.svg" alt="" className="h-5 w-5" />
            WAHooks
          </span>
          <div className="flex items-center gap-6">
            <Link
              href="/docs"
              className="text-sm text-text-tertiary hover:text-text-primary transition-colors"
            >
              Documentation
            </Link>
            <a
              href="https://github.com/dhruvyad/wahooks"
              className="text-sm text-text-tertiary hover:text-text-primary transition-colors"
            >
              GitHub
            </a>
            <span className="text-sm text-text-tertiary">
              &copy; {new Date().getFullYear()} WAHooks
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
