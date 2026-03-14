"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";
import { StatusBadge } from "@/components/status-badge";
import { ConnectionListSkeleton } from "@/components/skeletons";

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
    setCustomNames(names);

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
        <Link
          href="/connections/new"
          className="rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors duration-150 hover:bg-wa-green-dark"
        >
          New Connection
        </Link>
      </div>

      {loading && <ConnectionListSkeleton />}

      {error && (
        <div className="mt-6 rounded-lg border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          Failed to load connections: {error}
        </div>
      )}

      {!loading && !error && list.length === 0 && (
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
