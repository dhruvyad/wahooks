"use client";

import { useEffect, useState, useRef } from "react";
import { apiFetch } from "@/lib/api";

interface WebhookEventLog {
  id: string;
  eventType: string;
  status: string;
  attempts: number;
  deliveredAt: string | null;
  createdAt: string;
}

const DELIVERY_STATUS_CONFIG: Record<
  string,
  { label: string; className: string }
> = {
  pending: { label: "Pending", className: "bg-gray-100 text-gray-600" },
  delivered: { label: "Delivered", className: "bg-green-100 text-green-700" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700" },
};

function DeliveryStatusBadge({ status }: { status: string }) {
  const config = DELIVERY_STATUS_CONFIG[status] || {
    label: status,
    className: "bg-gray-100 text-gray-600",
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

export function EventLog({
  webhookId,
  expanded,
}: {
  webhookId: string;
  expanded: boolean;
}) {
  const [logs, setLogs] = useState<WebhookEventLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!expanded) {
      // Clear polling when collapsed
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

    // Fetch immediately
    setLoading(true);
    fetchLogs();

    // Poll every 10 seconds
    intervalRef.current = setInterval(fetchLogs, 10000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [expanded, webhookId]);

  if (!expanded) return null;

  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      <h4 className="text-sm font-medium text-gray-700">Event Log</h4>

      {loading && logs.length === 0 && (
        <p className="mt-2 text-sm text-gray-400">Loading logs...</p>
      )}

      {error && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}

      {!loading && !error && logs.length === 0 && (
        <p className="mt-2 text-sm text-gray-400">No events yet.</p>
      )}

      {logs.length > 0 && (
        <div className="mt-2 max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                <th className="pb-2 pr-4 font-medium">Event Type</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 pr-4 font-medium">Attempts</th>
                <th className="pb-2 font-medium">Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {logs.slice(0, 50).map((log) => (
                <tr
                  key={log.id}
                  className="border-b border-gray-50"
                >
                  <td className="py-2 pr-4">
                    <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                      {log.eventType}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    <DeliveryStatusBadge status={log.status} />
                  </td>
                  <td className="py-2 pr-4 text-gray-600">{log.attempts}</td>
                  <td className="py-2 text-gray-500">
                    {formatTimestamp(log.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
