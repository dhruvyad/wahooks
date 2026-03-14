import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-bg-primary">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border-primary bg-bg-primary/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-xl font-bold text-wa-green">
            WAHooks
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/docs"
              className="text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
            >
              Docs
            </Link>
            <Link
              href="/login"
              className="text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-md bg-wa-green px-4 py-2 text-sm font-medium text-text-inverse hover:bg-wa-green-dark transition-colors"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden px-6 py-32">
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-[500px] w-[500px] rounded-full bg-wa-green/5 blur-3xl" />
        </div>
        <div className="relative mx-auto max-w-4xl text-center">
          <h1 className="text-5xl font-bold leading-tight tracking-tight sm:text-6xl">
            WhatsApp Webhooks,{" "}
            <br className="hidden sm:block" />
            Deployed in{" "}
            <span className="text-wa-green">Seconds</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-text-secondary">
            Managed WAHA instances with automatic scaling, persistent sessions,
            and reliable webhook delivery. No infrastructure to manage.
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <Link
              href="/signup"
              className="rounded-md bg-wa-green px-6 py-3 text-sm font-medium text-text-inverse hover:bg-wa-green-dark transition-colors"
            >
              Get Started Free
            </Link>
            <a
              href="#features"
              className="rounded-md border border-border-secondary px-6 py-3 text-sm font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
            >
              Learn More
            </a>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="border-t border-border-primary px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center text-3xl font-bold">How It Works</h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-text-secondary">
            Get WhatsApp webhooks running in three simple steps.
          </p>
          <div className="mt-16 grid gap-8 sm:grid-cols-3">
            {[
              {
                step: "1",
                title: "Connect Your Number",
                description:
                  "Create a connection and scan the QR code with your WhatsApp app to link your number.",
              },
              {
                step: "2",
                title: "Configure Webhooks",
                description:
                  "Set your endpoint URL and choose which events to receive — messages, status changes, and more.",
              },
              {
                step: "3",
                title: "Receive Events",
                description:
                  "Get real-time webhook deliveries with HMAC-SHA256 signatures, automatic retries, and full event logs.",
              },
            ].map((item) => (
              <div
                key={item.step}
                className="rounded-lg border border-border-primary bg-bg-secondary p-6"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-wa-green text-sm font-bold text-text-inverse">
                  {item.step}
                </div>
                <h3 className="mt-4 text-lg font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm text-text-secondary">
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
        className="border-t border-border-primary px-6 py-24"
      >
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center text-3xl font-bold">
            Everything You Need
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-text-secondary">
            A complete platform for WhatsApp webhook integration.
          </p>
          <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                title: "Managed Instances",
                description:
                  "Cloud-hosted WAHA containers provisioned automatically. No servers to configure or maintain.",
              },
              {
                title: "Persistent Sessions",
                description:
                  "WhatsApp auth state persisted in the database. Sessions survive container restarts and VM replacements.",
              },
              {
                title: "Webhook Routing",
                description:
                  "Fan out WhatsApp events to your endpoints with configurable event filters per webhook.",
              },
              {
                title: "Event Logs",
                description:
                  "Full delivery history with status tracking, attempt counts, and payload inspection.",
              },
              {
                title: "Usage-Based Pricing",
                description:
                  "Pay only for what you use. $0.25 per connection per month, prorated to the hour.",
              },
              {
                title: "Secure by Default",
                description:
                  "HMAC-SHA256 signed deliveries, encrypted API keys, private network isolation, and no public exposure.",
              },
            ].map((feature) => (
              <div
                key={feature.title}
                className="rounded-lg border border-border-primary bg-bg-secondary p-6"
              >
                <h3 className="text-base font-semibold">{feature.title}</h3>
                <p className="mt-2 text-sm text-text-secondary">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="border-t border-border-primary px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center text-3xl font-bold">
            Simple, Transparent Pricing
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-text-secondary">
            No subscriptions. No hidden fees. Pay for what you use.
          </p>
          <div className="mx-auto mt-16 max-w-md rounded-lg border border-border-secondary bg-bg-secondary p-8 text-center">
            <p className="text-5xl font-bold text-wa-green">$0.25</p>
            <p className="mt-2 text-text-secondary">per connection / month</p>
            <ul className="mt-8 space-y-3 text-left text-sm text-text-secondary">
              <li className="flex items-start gap-2">
                <span className="mt-0.5 text-wa-green">&#10003;</span>
                Prorated hourly — only pay for active time
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 text-wa-green">&#10003;</span>
                Unlimited webhooks per connection
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 text-wa-green">&#10003;</span>
                Automatic retries with exponential backoff
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 text-wa-green">&#10003;</span>
                HMAC-SHA256 signed deliveries
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 text-wa-green">&#10003;</span>
                Full event logs and delivery tracking
              </li>
            </ul>
            <Link
              href="/signup"
              className="mt-8 inline-block rounded-md bg-wa-green px-8 py-3 text-sm font-medium text-text-inverse hover:bg-wa-green-dark transition-colors"
            >
              Start Building
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border-primary px-6 py-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <span className="text-sm font-semibold text-wa-green">WAHooks</span>
          <div className="flex items-center gap-6">
            <Link href="/docs" className="text-sm text-text-tertiary hover:text-text-primary transition-colors">
              Documentation
            </Link>
            <a href="https://github.com/dhruvyad/wahooks" className="text-sm text-text-tertiary hover:text-text-primary transition-colors">
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
