import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — WAHooks",
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <Link href="/" className="text-sm text-text-tertiary hover:text-text-secondary">
        &larr; Back to home
      </Link>

      <h1 className="mt-8 text-3xl font-bold text-text-primary">Privacy Policy</h1>
      <p className="mt-2 text-sm text-text-tertiary">Effective Date: March 16, 2026</p>

      <div className="prose-sm mt-8 space-y-6 text-text-secondary [&_h2]:mt-10 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-text-primary [&_h3]:mt-4 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-text-primary [&_strong]:text-text-primary [&_a]:text-wa-green [&_a:hover]:underline">

        <p>This Privacy Policy describes how WAHooks (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;), operated by Dhruv Yadav, collects, uses, and protects your personal information when you use our platform at wahooks.com (&quot;Service&quot;).</p>

        <h2>1. Information We Collect</h2>

        <h3>Account Information</h3>
        <p>Email address (via Google OAuth or email/password registration), name (if provided through Google OAuth). Passwords are hashed by Supabase Auth — we never see plaintext passwords.</p>

        <h3>WhatsApp Session Data</h3>
        <p>Phone numbers associated with your sessions, encrypted session authentication state, session metadata (status, timestamps, identifiers). We do not permanently store WhatsApp message content — messages are relayed to your webhook endpoints.</p>

        <h3>Webhook Configuration</h3>
        <p>Webhook URLs, event filters, signing secrets, and delivery logs (event type, delivery status, timestamps). Retained for debugging.</p>

        <h3>Billing Information</h3>
        <p>Stripe customer ID and subscription status. We do <strong>not</strong> store credit card numbers — all payment data is processed by Stripe.</p>

        <h3>Usage Analytics</h3>
        <p>Through PostHog: session recordings, page views, feature usage, device information, and IP address.</p>

        <h3>Cookies</h3>
        <ul className="list-disc pl-6 space-y-1">
          <li><strong>Authentication</strong> — session tokens to keep you logged in.</li>
          <li><strong>Country detection</strong> — for regional pricing.</li>
          <li><strong>Analytics</strong> — PostHog tracking for usage analytics.</li>
        </ul>

        <h2>2. How We Use Your Information</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>Provide and operate the Service (provision connections, deliver webhooks).</li>
          <li>Process payments and apply regional pricing.</li>
          <li>Improve the Service through aggregated analytics.</li>
          <li>Send service-related notifications and respond to support requests.</li>
          <li>Detect and prevent abuse, fraud, and unauthorized access.</li>
          <li>Comply with legal obligations.</li>
        </ul>

        <h2>3. Third-Party Services</h2>
        <p>We share data with the following providers, each with their own privacy policy:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li><strong>Supabase</strong> — Authentication and database hosting. <a href="https://supabase.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a></li>
          <li><strong>Stripe</strong> — Payment processing. <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a></li>
          <li><strong>PostHog</strong> — Product analytics and session recordings. <a href="https://posthog.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a></li>
          <li><strong>Vercel</strong> — Web dashboard hosting. <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">Privacy Policy</a></li>
          <li><strong>Hetzner Cloud</strong> — API and worker infrastructure (Germany). <a href="https://www.hetzner.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">Privacy Policy</a></li>
        </ul>
        <p>We do not sell your personal information to third parties.</p>

        <h2>4. Data Retention</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li><strong>Account data</strong> — retained while your account is active, deleted within 30 days of account deletion.</li>
          <li><strong>WhatsApp session data</strong> — deleted when you delete a connection.</li>
          <li><strong>Webhook delivery logs</strong> — retained for up to 30 days.</li>
          <li><strong>Billing records</strong> — up to 7 years (tax/accounting requirements).</li>
          <li><strong>Analytics data</strong> — up to 12 months.</li>
          <li><strong>Server logs</strong> — up to 90 days.</li>
        </ul>

        <h2>5. Data Security</h2>
        <p>All data in transit is encrypted via TLS. Session authentication state and API keys are stored encrypted. Infrastructure runs in a private Kubernetes cluster — WhatsApp workers are not publicly accessible. Authentication uses bcrypt password hashing and JWT tokens via Supabase Auth.</p>
        <p>No method of transmission or storage is 100% secure. We cannot guarantee absolute security.</p>

        <h2>6. Your Rights</h2>
        <p>Depending on your jurisdiction, you may have the right to:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li><strong>Access</strong> — request a copy of your personal data.</li>
          <li><strong>Correction</strong> — update your account information.</li>
          <li><strong>Deletion</strong> — request deletion of your account and data.</li>
          <li><strong>Data portability</strong> — export your data in a machine-readable format.</li>
          <li><strong>Object / Restrict processing</strong> — opt out of analytics by enabling &quot;Do Not Track&quot; or contacting us.</li>
          <li><strong>Withdraw consent</strong> — at any time, without affecting prior processing.</li>
        </ul>
        <p>Contact <a href="mailto:support@wahooks.com">support@wahooks.com</a> to exercise any of these rights. We respond within 30 days.</p>

        <h2>7. International Data Transfers</h2>
        <p>Our primary infrastructure is in Germany (Hetzner Cloud). The dashboard is hosted on Vercel (multiple regions). Third-party services may process data in various jurisdictions. By using the Service, you consent to these transfers.</p>

        <h2>8. Children&apos;s Privacy</h2>
        <p>The Service is not intended for individuals under 18. We do not knowingly collect data from children. Contact us if you believe a child has provided personal data.</p>

        <h2>9. Open Source</h2>
        <p>This Privacy Policy applies only to the hosted Service at wahooks.com. Self-hosted instances of the open source software are not covered — you are responsible for your own data handling practices.</p>

        <h2>10. Changes to This Policy</h2>
        <p>We may update this policy to reflect changes in our practices or legal requirements. Material changes will be communicated via email or dashboard notice. Continued use after changes constitutes acceptance.</p>

        <h2>11. Contact</h2>
        <p><strong>WAHooks</strong><br />Operated by Dhruv Yadav<br />Email: <a href="mailto:support@wahooks.com">support@wahooks.com</a></p>
      </div>
    </div>
  );
}
