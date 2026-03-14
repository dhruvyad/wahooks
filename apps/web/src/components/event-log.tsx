"use client";

import { useEffect, useState, useRef } from "react";
import { apiFetch } from "@/lib/api";

interface WebhookEventLog {
  id: string;
  eventType: string;
  payload?: { payload?: { body?: string } };
  status: string;
  attempts: number;
  deliveredAt: string | null;
  createdAt: string;
}

const DELIVERY_STATUS_CONFIG: Record<
  string,
  { label: string; className: string }
> = {
  pending: { label: "Pending", className: "bg-status-neutral-bg text-status-neutral-text" },
  delivered: { label: "Delivered", className: "bg-status-success-bg text-status-success-text" },
  failed: { label: "Failed", className: "bg-status-error-bg text-status-error-text" },
};

function DeliveryStatusBadge({ status }: { status: string }) {
  const config = DELIVERY_STATUS_CONFIG[status] || {
    label: status,
    className: "bg-status-neutral-bg text-status-neutral-text",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
}

function formatTimestamp(iso: string) {
  const date = new Date(iso);
  return date.toLocaleString();
}

function getMessageBody(log: WebhookEventLog): string | null {
  try {
    if (log.payload?.payload?.body) {
      return log.payload.payload.body;
    }
  } catch {
    // ignore
  }
  return null;
}

export function EventLog({
  webhookId,
  expanded,
  onToggle,
}: {
  webhookId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [logs, setLogs] = useState<WebhookEventLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!expanded) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    async function fetchLogs() {
      try {
        const data = await apiFetch(`/api/webhooks/${webhookId}/logs`);
        setLogs(data ?? []);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load event logs"
        );
      } finally {
        setLoading(false);
      }
    }

    setLoading(true);
    fetchLogs();

    intervalRef.current = setInterval(fetchLogs, 10000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [expanded, webhookId]);

  return (
    <div className="mt-3 border-t border-border-primary pt-3">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left"
        type="button"
      >
        <svg
          className={`h-4 w-4 shrink-0 text-text-tertiary transition-transform duration-200 ${
            expanded ? "rotate-90" : ""
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <h4 className="text-sm font-medium text-text-secondary">Event Log</h4>
      </button>

      {expanded && (
        <>
          {loading && logs.length === 0 && (
            <div className="mt-2 space-y-2">
              <div className="flex gap-4">
                <div className="h-4 w-20 animate-pulse rounded bg-bg-elevated" />
                <div className="h-4 w-16 animate-pulse rounded bg-bg-elevated" />
                <div className="h-4 w-8 animate-pulse rounded bg-bg-elevated" />
                <div className="h-4 w-32 animate-pulse rounded bg-bg-elevated" />
              </div>
              <div className="flex gap-4">
                <div className="h-4 w-20 animate-pulse rounded bg-bg-elevated" />
                <div className="h-4 w-16 animate-pulse rounded bg-bg-elevated" />
                <div className="h-4 w-8 animate-pulse rounded bg-bg-elevated" />
                <div className="h-4 w-32 animate-pulse rounded bg-bg-elevated" />
              </div>
            </div>
          )}

          {error && (
            <p className="mt-2 text-sm text-status-error-text">{error}</p>
          )}

          {!loading && !error && logs.length === 0 && (
            <p className="mt-2 text-sm text-text-tertiary">No events yet.</p>
          )}

          {logs.length > 0 && (
            <div className="mt-2 max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-primary text-left text-xs text-text-tertiary">
                    <th className="pb-2 pr-4 font-medium">Event Type</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Attempts</th>
                    <th className="pb-2 font-medium">Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.slice(0, 50).map((log) => {
                    const body = getMessageBody(log);
                    return (
                      <tr
                        key={log.id}
                        className="border-b border-border-primary/50"
                      >
                        <td className="py-2 pr-4">
                          <span className="inline-flex items-center rounded-full bg-bg-elevated px-2 py-0.5 text-xs font-medium text-text-secondary">
                            {log.eventType}
                          </span>
                          {body && (
                            <p className="mt-1 max-w-xs truncate text-xs text-text-tertiary">
                              {body}
                            </p>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <DeliveryStatusBadge status={log.status} />
                        </td>
                        <td className="py-2 pr-4 text-text-secondary">{log.attempts}</td>
                        <td className="py-2 text-text-tertiary">
                          {formatTimestamp(log.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
