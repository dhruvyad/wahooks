"use client";

import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";

interface Worker {
  id: string;
  podName: string;
  status: string;
  currentSessions: number;
  maxSessions: number;
  utilization: number;
  actualSessions: number;
}

interface InfraStatus {
  workers: Worker[];
  summary: {
    totalWorkers: number;
    drainingWorkers: number;
    totalCapacity: number;
    totalUsed: number;
    remainingSlots: number;
    utilization: number;
  };
  userSessions: {
    total: number;
    byStatus: Record<string, number>;
  };
}

function UtilizationBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const color =
    pct >= 80
      ? "bg-status-error-text"
      : pct >= 50
        ? "bg-status-warning-text"
        : "bg-wa-green";

  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 rounded-full bg-bg-elevated overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-text-tertiary w-8 text-right">{pct}%</span>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "active"
      ? "bg-wa-green"
      : status === "draining"
        ? "bg-status-warning-text"
        : "bg-status-neutral-text";

  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

export default function InfrastructurePage() {
  const { data, loading, error } = useApiData<InfraStatus>(
    "infrastructure",
    () => apiFetch("/api/infrastructure"),
    { revalidateInterval: 15000 }
  );

  return (
    <div className="animate-fade-in max-w-4xl">
      <h1 className="text-2xl font-bold text-text-primary">Infrastructure</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Worker nodes, capacity, and session distribution.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-status-error-border bg-status-error-bg p-3 text-sm text-status-error-text">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="mt-6 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-bg-elevated" />
          ))}
        </div>
      )}

      {data && (
        <>
          {/* Summary cards */}
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-border-primary bg-bg-secondary p-4">
              <p className="text-2xl font-bold text-text-primary">
                {data.summary.totalWorkers}
              </p>
              <p className="text-xs text-text-tertiary">Active Workers</p>
            </div>
            <div className="rounded-lg border border-border-primary bg-bg-secondary p-4">
              <p className="text-2xl font-bold text-text-primary">
                {data.summary.totalUsed}
                <span className="text-sm font-normal text-text-tertiary">
                  /{data.summary.totalCapacity}
                </span>
              </p>
              <p className="text-xs text-text-tertiary">Sessions Used</p>
            </div>
            <div className="rounded-lg border border-border-primary bg-bg-secondary p-4">
              <p className="text-2xl font-bold text-wa-green">
                {data.summary.remainingSlots}
              </p>
              <p className="text-xs text-text-tertiary">Slots Available</p>
            </div>
            <div className="rounded-lg border border-border-primary bg-bg-secondary p-4">
              <p className="text-2xl font-bold text-text-primary">
                {data.summary.utilization}%
              </p>
              <p className="text-xs text-text-tertiary">Utilization</p>
            </div>
          </div>

          {/* Overall utilization bar */}
          <div className="mt-3">
            <UtilizationBar
              value={data.summary.totalUsed}
              max={data.summary.totalCapacity}
            />
          </div>

          {/* Workers */}
          <h2 className="mt-6 text-sm font-semibold text-text-primary">
            Workers
          </h2>
          <div className="mt-2 space-y-2">
            {data.workers.length === 0 ? (
              <p className="text-sm text-text-tertiary">No active workers</p>
            ) : (
              data.workers.map((w) => (
                <div
                  key={w.id}
                  className="rounded-lg border border-border-primary bg-bg-secondary p-4 transition-colors duration-150 hover:border-border-secondary"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <StatusDot status={w.status} />
                      <span className="text-sm font-medium text-text-primary font-mono">
                        {w.podName}
                      </span>
                      <span className="rounded-full bg-bg-elevated px-2 py-0.5 text-[10px] text-text-tertiary">
                        {w.status}
                      </span>
                    </div>
                    <span className="text-sm text-text-secondary">
                      {w.currentSessions}/{w.maxSessions} sessions
                    </span>
                  </div>
                  <div className="mt-2">
                    <UtilizationBar value={w.currentSessions} max={w.maxSessions} />
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Your sessions */}
          <h2 className="mt-6 text-sm font-semibold text-text-primary">
            Your Sessions
          </h2>
          <div className="mt-2 rounded-lg border border-border-primary bg-bg-secondary p-4">
            <p className="text-sm text-text-primary">
              <span className="text-lg font-bold">{data.userSessions.total}</span>
              <span className="text-text-tertiary"> active sessions</span>
            </p>
            {Object.entries(data.userSessions.byStatus).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(data.userSessions.byStatus).map(([status, count]) => (
                  <span
                    key={status}
                    className="rounded-full bg-bg-elevated px-2.5 py-0.5 text-xs text-text-secondary"
                  >
                    {status}: {count}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Auto-refresh indicator */}
          <p className="mt-4 text-[11px] text-text-tertiary">
            Auto-refreshes every 15 seconds
          </p>
        </>
      )}
    </div>
  );
}
