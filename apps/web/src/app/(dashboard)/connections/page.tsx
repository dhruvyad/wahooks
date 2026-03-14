"use client";

import { useState, useEffect, startTransition } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";
import { StatusBadge } from "@/components/status-badge";
import { ConnectionListSkeleton } from "@/components/skeletons";
import { usePricing, formatTotal } from "@/lib/pricing";

interface BillingSlots {
  paid: number;
  used: number;
  available: number;
}

interface Connection {
  id: string;
  name: string | null;
  phoneNumber: string | null;
  status: string;
}

function getStoredName(connectionId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(`wahooks-conn-name-${connectionId}`);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Blurred QR empty state — shown when user has 0 connections AND    */
/*  no paid slots. Teases the QR scan flow to nudge them to buy.      */
/* ------------------------------------------------------------------ */

function QrUpgradePrompt() {
  const pricing = usePricing();
  const [quantity, setQuantity] = useState(1);
  const [redirecting, setRedirecting] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    QRCode.toDataURL(
      "https://wahooks.com/connect/placeholder-session-id",
      { width: 400, margin: 0, color: { dark: "#000000", light: "#ffffff" } },
    ).then(setQrDataUrl).catch(() => {});
  }, []);

  async function handleCheckout() {
    setRedirecting(true);
    try {
      const data = await apiFetch("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ quantity, currency: pricing.currency }),
      });
      if (data.url) {
        window.location.href = data.url;
      } else {
        // Slots added to existing subscription — reload
        window.location.reload();
      }
    } catch {
      setRedirecting(false);
    }
  }

  return (
    <div className="mt-8 flex flex-col items-center">
      <div className="relative">
        {/* Real QR code — lightly blurred */}
        {qrDataUrl && (
          <div className="rounded-2xl border border-border-primary bg-white p-3 blur-[2px]">
            <img
              src={qrDataUrl}
              alt=""
              className="h-[320px] w-[320px]"
              draggable={false}
            />
          </div>
        )}

        {/* Overlay */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-72 rounded-xl border border-border-secondary bg-bg-secondary/95 p-5 text-center shadow-xl backdrop-blur-sm">
            <p className="text-sm font-semibold text-text-primary">
              You need a connection slot
            </p>
            <p className="mt-1 text-xs text-text-secondary">
              Each WhatsApp connection costs {pricing.label}/month.
            </p>

            <div className="mt-4 flex items-center justify-center gap-2">
              <div className="flex items-center rounded-lg border border-border-secondary">
                <button
                  type="button"
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  className="px-2.5 py-1 text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                  −
                </button>
                <span className="min-w-[1.75rem] text-center text-sm font-medium text-text-primary">
                  {quantity}
                </span>
                <button
                  type="button"
                  onClick={() => setQuantity(quantity + 1)}
                  className="px-2.5 py-1 text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                  +
                </button>
              </div>
              <span className="text-xs text-text-tertiary">
                slot{quantity !== 1 ? "s" : ""} &middot; {formatTotal(quantity, pricing)}/mo
              </span>
            </div>

            <button
              onClick={handleCheckout}
              disabled={redirecting}
              className="mt-3 w-full rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors hover:bg-wa-green-dark disabled:opacity-50"
            >
              {redirecting ? "Redirecting..." : "Buy & Connect"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ConnectionsPage() {
  const {
    data: connections,
    loading,
    error,
  } = useApiData<Connection[]>("connections", () =>
    apiFetch("/api/connections")
  );

  const list = connections ?? [];

  // Fetch billing slots
  const [slots, setSlots] = useState<BillingSlots | null>(null);
  useEffect(() => {
    apiFetch("/api/billing/status")
      .then((data: any) => setSlots(data?.slots ?? null))
      .catch(() => {});
  }, []);

  // Read custom names from localStorage + fetch phone numbers for working connections
  const [customNames, setCustomNames] = useState<Record<string, string>>({});
  const [phoneNumbers, setPhoneNumbers] = useState<Record<string, string>>({});
  useEffect(() => {
    if (list.length === 0) return;
    const names: Record<string, string> = {};
    for (const conn of list) {
      const stored = getStoredName(conn.id);
      if (stored) names[conn.id] = stored;
    }
    startTransition(() => setCustomNames(names));

    // Fetch phone numbers for connected accounts
    const working = list.filter((c) => c.status === "working");
    if (working.length === 0) return;
    Promise.all(
      working.map((c) =>
        apiFetch(`/api/connections/${c.id}/me`)
          .then((me: any) => ({ id: c.id, phone: me?.id?.replace("@c.us", "") || null }))
          .catch(() => ({ id: c.id, phone: null }))
      )
    ).then((results) => {
      const phones: Record<string, string> = {};
      for (const r of results) {
        if (r.phone) phones[r.id] = r.phone;
      }
      setPhoneNumbers(phones);
    });
  }, [list]);

  const needsUpgrade = slots !== null && slots.paid === 0;

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Connections</h1>
          {slots && (
            <p className="mt-0.5 text-xs text-text-tertiary">
              {slots.used}/{slots.paid} slots used
              {slots.available > 0 ? (
                <span className="text-wa-green"> · {slots.available} available</span>
              ) : slots.paid > 0 ? (
                <span className="text-status-error-text"> · 0 available</span>
              ) : (
                <span> · <Link href="/billing" className="text-wa-green hover:underline">Set up billing</Link></span>
              )}
            </p>
          )}
        </div>
        {!needsUpgrade && (
          <Link
            href="/connections/new"
            className="rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors duration-150 hover:bg-wa-green-dark"
          >
            New Connection
          </Link>
        )}
      </div>

      {loading && <ConnectionListSkeleton />}

      {error && (
        <div className="mt-6 rounded-lg border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          Failed to load connections: {error}
        </div>
      )}

      {/* Empty state with blurred QR — user has no connections AND no paid slots */}
      {!loading && !error && list.length === 0 && needsUpgrade && (
        <QrUpgradePrompt />
      )}

      {/* Empty state — user has paid slots but no connections yet */}
      {!loading && !error && list.length === 0 && !needsUpgrade && (
        <div className="mt-16 flex flex-col items-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border-primary bg-bg-secondary">
            <span className="text-3xl">📱</span>
          </div>
          <p className="mt-4 text-base font-medium text-text-primary">
            No connections yet
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            Create your first WhatsApp connection to get started.
          </p>
          <Link
            href="/connections/new"
            className="mt-6 rounded-lg bg-wa-green px-5 py-2.5 text-sm font-semibold text-text-inverse transition-colors duration-150 hover:bg-wa-green-dark"
          >
            Create a connection
          </Link>
        </div>
      )}

      {!loading && !error && list.length > 0 && (
        <div className="mt-6 space-y-2">
          {list.map((conn) => (
            <Link
              key={conn.id}
              href={`/connections/${conn.id}`}
              className="group relative flex items-center justify-between rounded-xl border border-border-primary bg-bg-secondary px-5 py-4 transition-all duration-150 hover:border-border-secondary hover:bg-bg-elevated"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-text-primary">
                  {customNames[conn.id] || conn.name || "Unnamed Connection"}
                </p>
                <p className="mt-0.5 text-xs text-text-tertiary">
                  {phoneNumbers[conn.id]
                    ? `+${phoneNumbers[conn.id]}`
                    : conn.phoneNumber
                      ? conn.phoneNumber
                      : conn.status === "working"
                        ? "Loading..."
                        : "No phone linked"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 ml-3">
                <StatusBadge status={conn.status} />
                <svg
                  className="h-4 w-4 text-text-tertiary transition-colors duration-150 group-hover:text-text-secondary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
