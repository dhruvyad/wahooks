"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";

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
    active: "bg-green-100 text-green-800",
    past_due: "bg-yellow-100 text-yellow-800",
    canceled: "bg-red-100 text-red-800",
    incomplete: "bg-gray-100 text-gray-800",
  };

  const labels: Record<string, string> = {
    active: "Active",
    past_due: "Past Due",
    canceled: "Canceled",
    incomplete: "Incomplete",
  };

  const style = styles[status] || "bg-gray-100 text-gray-800";
  const label = labels[status] || status;

  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}
    >
      {label}
    </span>
  );
}

export default function BillingPage() {
  const searchParams = useSearchParams();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);

  const success = searchParams.get("success") === "true";
  const canceled = searchParams.get("canceled") === "true";

  useEffect(() => {
    apiFetch("/api/billing/status")
      .then((data) => {
        setBilling(data);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load billing status");
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  async function handleSetupPayment() {
    setRedirecting(true);
    try {
      const data = await apiFetch("/api/billing/checkout", { method: "POST" });
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start checkout");
      setRedirecting(false);
    }
  }

  async function handleManageBilling() {
    setRedirecting(true);
    try {
      const data = await apiFetch("/api/billing/portal", { method: "POST" });
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open billing portal");
      setRedirecting(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Billing</h1>

      {/* Stripe redirect banners */}
      {success && (
        <div className="mt-4 rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-700">
          Payment method added successfully. Your billing is now set up.
        </div>
      )}

      {canceled && (
        <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-700">
          Checkout was canceled. You can set up billing whenever you are ready.
        </div>
      )}

      {loading && (
        <div className="mt-12 text-center">
          <p className="text-gray-500">Loading billing information...</p>
        </div>
      )}

      {error && (
        <div className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && billing && (
        <div className="mt-6 space-y-6">
          {/* Subscription status card */}
          <div className="rounded-md border border-gray-200 p-6">
            <h2 className="text-lg font-semibold">Subscription</h2>

            {!billing.subscriptionStatus || billing.subscriptionStatus === "incomplete" ? (
              <div className="mt-3">
                <p className="text-sm text-gray-600">
                  Set up billing to start using WAHooks. You will be charged based on
                  usage: <span className="font-medium">$0.25 per connection per month</span>,
                  prorated to the hour.
                </p>
                <button
                  onClick={handleSetupPayment}
                  disabled={redirecting}
                  className="mt-4 rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                >
                  {redirecting ? "Redirecting..." : "Set Up Payment"}
                </button>
              </div>
            ) : billing.subscriptionStatus === "active" ? (
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600">Status:</span>
                  <SubscriptionBadge status="active" />
                </div>
                <button
                  onClick={handleManageBilling}
                  disabled={redirecting}
                  className="mt-4 rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                >
                  {redirecting ? "Redirecting..." : "Manage Billing"}
                </button>
              </div>
            ) : billing.subscriptionStatus === "past_due" ? (
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600">Status:</span>
                  <SubscriptionBadge status="past_due" />
                </div>
                <p className="mt-2 text-sm text-yellow-700">
                  Your payment is past due. Please update your payment method to avoid
                  service interruption.
                </p>
                <button
                  onClick={handleManageBilling}
                  disabled={redirecting}
                  className="mt-4 rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                >
                  {redirecting ? "Redirecting..." : "Update Payment"}
                </button>
              </div>
            ) : (
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600">Status:</span>
                  <SubscriptionBadge status={billing.subscriptionStatus} />
                </div>
                <button
                  onClick={handleManageBilling}
                  disabled={redirecting}
                  className="mt-4 rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                >
                  {redirecting ? "Redirecting..." : "Manage Billing"}
                </button>
              </div>
            )}
          </div>

          {/* Usage summary card */}
          <div className="rounded-md border border-gray-200 p-6">
            <h2 className="text-lg font-semibold">Current Month Usage</h2>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <p className="text-sm text-gray-500">Connection-Hours</p>
                <p className="mt-1 text-xl font-semibold">
                  {billing.usage.totalHours.toFixed(1)}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Active Connections</p>
                <p className="mt-1 text-xl font-semibold">
                  {billing.usage.activeConnections}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Estimated Cost</p>
                <p className="mt-1 text-xl font-semibold">
                  ${billing.usage.estimatedCost.toFixed(2)}
                </p>
              </div>
            </div>
            <p className="mt-4 text-xs text-gray-400">
              $0.25 per connection per month, billed hourly
            </p>
          </div>

          {/* Pricing explanation */}
          <div className="rounded-md border border-gray-200 bg-gray-50 p-6">
            <h2 className="text-lg font-semibold">How Pricing Works</h2>
            <p className="mt-2 text-sm text-gray-600">
              You are billed based on usage. Each active WhatsApp connection costs
              $0.25/month, prorated to the hour. You only pay for the time your
              connections are active.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
