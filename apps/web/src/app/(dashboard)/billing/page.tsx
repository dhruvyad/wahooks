"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";
import { BillingSkeleton } from "@/components/skeletons";

interface BillingStatus {
  hasPaymentMethod: boolean;
  subscriptionStatus: string | null;
  usage: {
    totalHours: number;
    estimatedCost: number;
    activeConnections: number;
  };
}

function SubscriptionBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active:
      "bg-status-success-bg text-status-success-text",
    past_due:
      "bg-status-warning-bg text-status-warning-text",
    canceled:
      "bg-status-error-bg text-status-error-text",
    incomplete:
      "bg-status-neutral-bg text-status-neutral-text",
  };

  const labels: Record<string, string> = {
    active: "Active",
    past_due: "Past Due",
    canceled: "Canceled",
    incomplete: "Incomplete",
  };

  const style =
    styles[status] || "bg-status-neutral-bg text-status-neutral-text";
  const label = labels[status] || status;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {label}
    </span>
  );
}

export default function BillingPage() {
  const searchParams = useSearchParams();
  const [redirecting, setRedirecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const {
    data: billing,
    loading,
    error,
  } = useApiData<BillingStatus>("billing", () =>
    apiFetch("/api/billing/status")
  );

  const success = searchParams.get("success") === "true";
  const canceled = searchParams.get("canceled") === "true";

  async function handleSetupPayment() {
    setRedirecting(true);
    try {
      const data = await apiFetch("/api/billing/checkout", { method: "POST" });
      window.location.href = data.url;
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to start checkout"
      );
      setRedirecting(false);
    }
  }

  async function handleManageBilling() {
    setRedirecting(true);
    try {
      const data = await apiFetch("/api/billing/portal", { method: "POST" });
      window.location.href = data.url;
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to open billing portal"
      );
      setRedirecting(false);
    }
  }

  const displayError = error || actionError;

  return (
    <div className="animate-fade-in">
      <h1 className="text-2xl font-bold text-text-primary">Billing</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Manage your subscription and view usage.
      </p>

      {success && (
        <div className="mt-4 rounded-lg border border-status-success-border bg-status-success-bg p-4 text-sm text-status-success-text">
          Payment method added successfully. Your billing is now set up.
        </div>
      )}

      {canceled && (
        <div className="mt-4 rounded-lg border border-status-info-border bg-status-info-bg p-4 text-sm text-status-info-text">
          Checkout was canceled. You can set up billing whenever you are ready.
        </div>
      )}

      {loading && <BillingSkeleton />}

      {displayError && (
        <div className="mt-6 rounded-lg border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          {displayError}
        </div>
      )}

      {!loading && !error && billing && (
        <div className="mt-6 space-y-4">
          {/* Subscription status card */}
          <div className="rounded-xl border border-border-primary bg-bg-secondary p-6 transition-colors duration-150 hover:border-border-secondary">
            <h2 className="text-base font-semibold text-text-primary">
              Subscription
            </h2>

            {!billing.subscriptionStatus ||
            billing.subscriptionStatus === "incomplete" ? (
              <div className="mt-3">
                <p className="text-sm text-text-secondary">
                  Set up billing to start using WAHooks. You will be charged
                  based on usage:{" "}
                  <span className="font-medium text-text-primary">
                    $0.25 per connection per month
                  </span>
                  , prorated to the hour.
                </p>
                <button
                  onClick={handleSetupPayment}
                  disabled={redirecting}
                  className="mt-4 rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors duration-150 hover:bg-wa-green-dark disabled:opacity-50"
                >
                  {redirecting ? "Redirecting..." : "Set Up Payment"}
                </button>
              </div>
            ) : billing.subscriptionStatus === "active" ? (
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-text-secondary">Status:</span>
                  <SubscriptionBadge status="active" />
                </div>
                <button
                  onClick={handleManageBilling}
                  disabled={redirecting}
                  className="mt-4 rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors duration-150 hover:bg-wa-green-dark disabled:opacity-50"
                >
                  {redirecting ? "Redirecting..." : "Manage Billing"}
                </button>
              </div>
            ) : billing.subscriptionStatus === "past_due" ? (
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-text-secondary">Status:</span>
                  <SubscriptionBadge status="past_due" />
                </div>
                <p className="mt-2 text-sm text-status-warning-text">
                  Your payment is past due. Please update your payment method
                  to avoid service interruption.
                </p>
                <button
                  onClick={handleManageBilling}
                  disabled={redirecting}
                  className="mt-4 rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors duration-150 hover:bg-wa-green-dark disabled:opacity-50"
                >
                  {redirecting ? "Redirecting..." : "Update Payment"}
                </button>
              </div>
            ) : (
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-text-secondary">Status:</span>
                  <SubscriptionBadge status={billing.subscriptionStatus} />
                </div>
                <button
                  onClick={handleManageBilling}
                  disabled={redirecting}
                  className="mt-4 rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors duration-150 hover:bg-wa-green-dark disabled:opacity-50"
                >
                  {redirecting ? "Redirecting..." : "Manage Billing"}
                </button>
              </div>
            )}
          </div>

          {/* Usage summary card */}
          <div className="rounded-xl border border-border-primary bg-bg-secondary p-6 transition-colors duration-150 hover:border-border-secondary">
            <h2 className="text-base font-semibold text-text-primary">
              Current Month Usage
            </h2>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-lg border border-border-primary bg-bg-elevated p-4">
                <p className="text-xs font-medium text-text-tertiary uppercase tracking-wide">
                  Connection-Hours
                </p>
                <p className="mt-2 text-2xl font-semibold text-text-primary">
                  {billing.usage.totalHours.toFixed(1)}
                </p>
              </div>
              <div className="rounded-lg border border-border-primary bg-bg-elevated p-4">
                <p className="text-xs font-medium text-text-tertiary uppercase tracking-wide">
                  Active Connections
                </p>
                <p className="mt-2 text-2xl font-semibold text-text-primary">
                  {billing.usage.activeConnections}
                </p>
              </div>
              <div className="rounded-lg border border-border-primary bg-bg-elevated p-4">
                <p className="text-xs font-medium text-text-tertiary uppercase tracking-wide">
                  Estimated Cost
                </p>
                <p className="mt-2 text-2xl font-semibold text-wa-green">
                  ${billing.usage.estimatedCost.toFixed(2)}
                </p>
              </div>
            </div>
            <p className="mt-4 text-xs text-text-tertiary">
              $0.25 per connection per month, billed hourly
            </p>
          </div>

          {/* Pricing explanation */}
          <div className="rounded-xl border border-border-primary bg-bg-tertiary p-6 transition-colors duration-150 hover:border-border-secondary">
            <h2 className="text-base font-semibold text-text-primary">
              How Pricing Works
            </h2>
            <p className="mt-2 text-sm text-text-secondary">
              You are billed based on usage. Each active WhatsApp connection
              costs $0.25/month, prorated to the hour. You only pay for the
              time your connections are active.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
