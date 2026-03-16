import Link from "next/link";

export const metadata = {
  title: "Terms of Service — WAHooks",
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <Link href="/" className="text-sm text-text-tertiary hover:text-text-secondary">
        &larr; Back to home
      </Link>

      <h1 className="mt-8 text-3xl font-bold text-text-primary">Terms of Service</h1>
      <p className="mt-2 text-sm text-text-tertiary">Effective Date: March 16, 2026</p>

      <div className="prose-sm mt-8 space-y-6 text-text-secondary [&_h2]:mt-10 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-text-primary [&_h3]:mt-4 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-text-primary [&_strong]:text-text-primary [&_a]:text-wa-green [&_a:hover]:underline">

        <p>These Terms of Service (&quot;Terms&quot;) govern your access to and use of WAHooks (&quot;Service&quot;), a cloud-hosted WhatsApp webhook API platform available at wahooks.com. The Service is operated by Dhruv Yadav (&quot;WAHooks&quot;, &quot;we&quot;, &quot;us&quot;, &quot;our&quot;).</p>
        <p>By creating an account or using the Service, you agree to be bound by these Terms. If you do not agree, do not use the Service.</p>

        <h2>1. Definitions</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li><strong>&quot;Service&quot;</strong> refers to the WAHooks platform, including the dashboard, API, webhook delivery infrastructure, and all related services.</li>
          <li><strong>&quot;Connection&quot;</strong> refers to a single WhatsApp session provisioned through the Service.</li>
          <li><strong>&quot;User&quot;</strong>, <strong>&quot;you&quot;</strong>, <strong>&quot;your&quot;</strong> refers to the individual or entity that registers for and uses the Service.</li>
        </ul>

        <h2>2. Account Registration</h2>
        <p>You must create an account to use the Service. You may register using Google OAuth or email and password authentication. You must provide accurate and complete registration information and keep your account credentials secure. You are responsible for all activity that occurs under your account.</p>
        <p>You must be at least 18 years of age or the age of legal majority in your jurisdiction to use the Service.</p>

        <h2>3. Description of the Service</h2>
        <p>WAHooks provides cloud-hosted WhatsApp API instances that allow you to receive WhatsApp events via configurable webhooks delivered to your specified endpoints. The Service acts as an intermediary layer. WAHooks does not control WhatsApp&apos;s platform, policies, or availability.</p>
        <p>The Service is provided on an &quot;as available&quot; basis. We do not guarantee uninterrupted availability.</p>

        <h2>4. API Usage</h2>
        <p>Access to the WAHooks API is granted solely for the purpose of integrating WhatsApp event data into your own applications and workflows. You must not share your API credentials or webhook signing secrets with unauthorized third parties. We reserve the right to impose rate limits or usage quotas.</p>

        <h2>5. Acceptable Use</h2>
        <p>You agree not to use the Service to:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Send unsolicited bulk messages, spam, or engage in mass messaging campaigns.</li>
          <li>Harass, abuse, threaten, or intimidate any person.</li>
          <li>Violate WhatsApp&apos;s Terms of Service or Acceptable Use Policy.</li>
          <li>Transmit unlawful, defamatory, obscene, or malicious content.</li>
          <li>Interfere with or disrupt the Service or its underlying infrastructure.</li>
          <li>Use the Service for any purpose that violates applicable law.</li>
        </ul>
        <p>Violation may result in immediate suspension or termination without notice or refund.</p>

        <h2>6. Billing and Payment</h2>
        <p>The Service is billed on a prepaid subscription model at $0.99 per connection per month (regional pricing may apply). Payments are processed through Stripe. Subscriptions renew automatically unless cancelled before renewal.</p>
        <p><strong>Refunds.</strong> Because the Service provisions cloud infrastructure immediately, refunds are generally not provided. We may issue refunds at our sole discretion for documented service failures. Contact support@wahooks.com for requests.</p>
        <p>If payment fails, connections may be suspended. Connections suspended for non-payment for more than 14 days may be permanently deleted.</p>

        <h2>7. Data Handling</h2>
        <p>We store data necessary to operate the Service, including account information, WhatsApp session metadata, webhook configuration, and delivery logs. See our <Link href="/privacy">Privacy Policy</Link> for details.</p>
        <p>You are solely responsible for data you receive through webhooks and must handle it in compliance with all applicable data protection laws.</p>

        <h2>8. Intellectual Property</h2>
        <p>Certain components of WAHooks are released as open source under the MIT license. The WAHooks name, logo, and branding are our property. You retain all rights to data you transmit through the Service.</p>

        <h2>9. Limitation of Liability</h2>
        <p className="uppercase text-xs">To the maximum extent permitted by law, WAHooks shall not be liable for any indirect, incidental, special, consequential, or punitive damages. Our total aggregate liability shall not exceed the amount you paid to WAHooks in the twelve (12) months preceding the claim.</p>
        <p>We are not liable for damages arising from WhatsApp blocking your account, third-party infrastructure failures, or your failure to secure your endpoints.</p>

        <h2>10. Disclaimer of Warranties</h2>
        <p className="uppercase text-xs">The Service is provided &quot;as is&quot; and &quot;as available&quot; without warranties of any kind. We disclaim all warranties, including implied warranties of merchantability, fitness for a particular purpose, and non-infringement.</p>

        <h2>11. Termination</h2>
        <p>You may terminate your account at any time by cancelling your subscription and contacting support@wahooks.com. We may suspend or terminate your access at any time for violation of these Terms or non-payment.</p>

        <h2>12. Changes to These Terms</h2>
        <p>We may update these Terms from time to time. Material changes will be communicated via email or dashboard notice. Continued use after changes constitutes acceptance.</p>

        <h2>13. Contact</h2>
        <p><strong>WAHooks</strong><br />Operated by Dhruv Yadav<br />Email: <a href="mailto:support@wahooks.com">support@wahooks.com</a></p>
      </div>
    </div>
  );
}
