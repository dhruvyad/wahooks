"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";
import { BillingSkeleton } from "@/components/skeletons";
import { getPricing, formatTotal } from "@/lib/pricing";

interface BillingStatus {
  subscription: {
    active: boolean;
    status: string | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
    monthlyAmount: number;
    currency: string;
  };
  slots: {
    paid: number;
    used: number;
    available: number;
  };
}

function BillingContent() {
  const searchParams = useSearchParams();
  const pricing = getPricing();
  const [redirecting, setRedirecting] = useState(false);
  const [buyQuantity, setBuyQuantity] = useState(1);

  const {
    data: billing,
    loading,
    error,
    mutate,
  } = useApiData<BillingStatus>("billing", () =>
    apiFetch("/api/billing/status")
  );

  const success = searchParams.get("success") === "true";
  const canceled = searchParams.get("canceled") === "true";

  async function handleCheckout() {
    setRedirecting(true);
    try {
      const data = await apiFetch("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ quantity: buyQuantity, currency: pricing.currency }),
      });
      if (data.url) {
        window.location.href = data.url;
      } else {
        // Slots added to existing subscription
        mutate(undefined);
        setRedirecting(false);
      }
    } catch {
      setRedirecting(false);
    }
  }

  async function handlePortal() {
    setRedirecting(true);
    try {
      const data = await apiFetch("/api/billing/portal", { method: "POST" });
      window.location.href = data.url;
    } catch {
      setRedirecting(false);
    }
  }

  return (
    <div className="animate-fade-in max-w-2xl">
      <h1 className="text-2xl font-bold text-text-primary">Billing</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Manage your connection slots and subscription.
      </p>

      {success && (
        <div className="mt-4 rounded-lg border border-status-success-border bg-status-success-bg p-4 text-sm text-status-success-text">
          Payment successful! Your connection slots are now active.
        </div>
      )}

      {canceled && (
        <div className="mt-4 rounded-lg border border-status-info-border bg-status-info-bg p-4 text-sm text-status-info-text">
          Checkout was canceled. You can set up billing whenever you&apos;re ready.
        </div>
      )}

      {loading && !billing && <BillingSkeleton />}

      {error && (
        <div className="mt-6 rounded-lg border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          {error}
        </div>
      )}

      {billing && (
        <div className="mt-6 space-y-4">
          {/* Slots overview */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-border-primary bg-bg-secondary p-4">
              <p className="text-2xl font-bold text-text-primary">{billing.slots.paid}</p>
              <p className="text-xs text-text-tertiary">Paid Slots</p>
            </div>
            <div className="rounded-lg border border-border-primary bg-bg-secondary p-4">
              <p className="text-2xl font-bold text-text-primary">{billing.slots.used}</p>
              <p className="text-xs text-text-tertiary">In Use</p>
            </div>
            <div className="rounded-lg border border-border-primary bg-bg-secondary p-4">
              <p className={`text-2xl font-bold ${billing.slots.available > 0 ? "text-wa-green" : "text-status-error-text"}`}>
                {billing.slots.available}
              </p>
              <p className="text-xs text-text-tertiary">Available</p>
            </div>
          </div>

          {/* Subscription status */}
          {billing.subscription.active ? (
            <div className="rounded-lg border border-border-primary bg-bg-secondary p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-text-primary">Subscription</h2>
                    {billing.subscription.cancelAtPeriodEnd ? (
                      <span className="rounded-full bg-status-warning-bg px-2 py-0.5 text-[10px] font-medium text-status-warning-text">
                        Canceling
                      </span>
                    ) : (
                      <span className="rounded-full bg-status-success-bg px-2 py-0.5 text-[10px] font-medium text-status-success-text">
                        Active
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-text-secondary">
                    {billing.slots.paid} slot{billing.slots.paid !== 1 ? "s" : ""} &middot;{" "}
                    {billing.subscription.currency.toUpperCase()}{" "}
                    {billing.subscription.monthlyAmount.toFixed(2)}/month
                    {billing.subscription.currentPeriodEnd && (
                      <span className="text-text-tertiary">
                        {" "}&middot;{" "}
                        {billing.subscription.cancelAtPeriodEnd ? "Expires" : "Renews"}{" "}
                        {new Date(billing.subscription.currentPeriodEnd).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </span>
                    )}
                  </p>
                </div>
                <button
                  onClick={handlePortal}
                  disabled={redirecting}
                  className="rounded-lg border border-border-secondary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
                >
                  Manage
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border-primary bg-bg-secondary p-5">
              <h2 className="text-sm font-semibold text-text-primary">No Active Subscription</h2>
              <p className="mt-1 text-sm text-text-secondary">
                Buy connection slots to start using WAHooks.
                Each slot is {pricing.label}/month.
              </p>
            </div>
          )}

          {/* Buy slots */}
          <div className="rounded-lg border border-border-primary bg-bg-secondary p-5">
            <h2 className="text-sm font-semibold text-text-primary">
              {billing.subscription.active ? "Add More Slots" : "Buy Connection Slots"}
            </h2>
            <div className="mt-3 flex items-center gap-3">
              <div className="flex items-center rounded-lg border border-border-secondary">
                <button
                  type="button"
                  onClick={() => setBuyQuantity(Math.max(1, buyQuantity - 1))}
                  className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                  −
                </button>
                <span className="min-w-[2rem] text-center text-sm font-medium text-text-primary">
                  {buyQuantity}
                </span>
                <button
                  type="button"
                  onClick={() => setBuyQuantity(buyQuantity + 1)}
                  className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                  +
                </button>
              </div>
              <span className="text-sm text-text-tertiary">
                × {pricing.label}/mo = {formatTotal(buyQuantity, pricing)}/mo
              </span>
              <button
                onClick={handleCheckout}
                disabled={redirecting}
                className="ml-auto rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors hover:bg-wa-green-dark disabled:opacity-50"
              >
                {redirecting ? "..." : billing.subscription.active ? "Add Slots" : "Subscribe"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={<BillingSkeleton />}>
      <BillingContent />
    </Suspense>
  );
}
