"use client";

import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";
import { StatusBadge } from "@/components/status-badge";
import { ConnectionListSkeleton } from "@/components/skeletons";

interface Connection {
  id: string;
  name: string | null;
  status: string;
  me: { id: string; pushName?: string } | null;
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

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary">Connections</h1>
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
              className="group flex items-center justify-between rounded-xl border border-border-primary bg-bg-secondary px-5 py-4 transition-all duration-150 hover:border-border-secondary hover:bg-bg-elevated"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-text-primary">
                    {conn.name || "Unnamed Connection"}
                  </p>
                  <p className="mt-0.5 text-xs text-text-tertiary">
                    {conn.me?.id
                      ? conn.me.id.replace("@c.us", "")
                      : "No phone linked"}
                  </p>
                </div>
                <StatusBadge status={conn.status} />
              </div>
              <svg
                className="h-4 w-4 shrink-0 text-text-tertiary transition-colors duration-150 group-hover:text-text-secondary"
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
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
