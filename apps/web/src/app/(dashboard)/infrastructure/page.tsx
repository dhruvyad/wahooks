"use client";

import { startTransition, useEffect, useRef, useState } from "react";
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

interface WebhookQueue {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  reachable: boolean;
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
  webhookQueue: WebhookQueue;
  timestamp: string;
}

interface QueueSample {
  t: number; // unix ms
  waiting: number;
  active: number;
  failed: number;
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

function Sparkline({
  samples,
  field,
  color,
}: {
  samples: QueueSample[];
  field: "waiting" | "active" | "failed";
  color: string;
}) {
  const W = 320;
  const H = 60;
  if (samples.length < 2) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="h-12 w-full text-text-tertiary">
        <text x="6" y="20" fontSize="10" fill="currentColor">
          Collecting samples…
        </text>
      </svg>
    );
  }

  const values = samples.map((s) => s[field]);
  const max = Math.max(...values, 1);
  const min = 0;
  const dx = W / Math.max(samples.length - 1, 1);
  const points = samples
    .map((s, i) => {
      const x = i * dx;
      const y = H - ((s[field] - min) / (max - min || 1)) * (H - 6) - 3;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-12 w-full" preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
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

  // Rolling buffer of queue samples while the page is open (last 30 min at 15s = 120 samples).
  const MAX_SAMPLES = 120;
  const [samples, setSamples] = useState<QueueSample[]>([]);
  const lastTs = useRef<string | null>(null);

  useEffect(() => {
    if (!data?.webhookQueue || !data.webhookQueue.reachable) return;
    if (data.timestamp === lastTs.current) return;
    lastTs.current = data.timestamp;
    const sample = {
      t: Date.parse(data.timestamp),
      waiting: data.webhookQueue.waiting,
      active: data.webhookQueue.active,
      failed: data.webhookQueue.failed,
    };
    startTransition(() => {
      setSamples((prev) => {
        const next = [...prev, sample];
        return next.length > MAX_SAMPLES ? next.slice(-MAX_SAMPLES) : next;
      });
    });
  }, [data]);

  // Trend over the visible window.
  const trend = (() => {
    if (samples.length < 2) return null;
    const first = samples[0].waiting;
    const last = samples[samples.length - 1].waiting;
    const delta = last - first;
    const minutes = (samples[samples.length - 1].t - samples[0].t) / 60_000;
    const ratePerMin = minutes > 0 ? delta / minutes : 0;
    return { delta, ratePerMin, minutes };
  })();

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

          {/* Webhook delivery queue */}
          <h2 className="mt-6 text-sm font-semibold text-text-primary">
            Webhook Delivery Queue
          </h2>
          {!data.webhookQueue.reachable ? (
            <p className="mt-2 text-sm text-status-error-text">
              Queue unreachable (Redis connection failed)
            </p>
          ) : (
            <>
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg border border-border-primary bg-bg-secondary p-4">
                  <p className="text-2xl font-bold text-text-primary">
                    {data.webhookQueue.waiting.toLocaleString()}
                  </p>
                  <p className="text-xs text-text-tertiary">Waiting</p>
                </div>
                <div className="rounded-lg border border-border-primary bg-bg-secondary p-4">
                  <p className="text-2xl font-bold text-wa-green">
                    {data.webhookQueue.active}
                  </p>
                  <p className="text-xs text-text-tertiary">Active</p>
                </div>
                <div className="rounded-lg border border-border-primary bg-bg-secondary p-4">
                  <p className="text-2xl font-bold text-status-warning-text">
                    {data.webhookQueue.delayed}
                  </p>
                  <p className="text-xs text-text-tertiary">Delayed (retry)</p>
                </div>
                <div className="rounded-lg border border-border-primary bg-bg-secondary p-4">
                  <p className="text-2xl font-bold text-status-error-text">
                    {data.webhookQueue.failed.toLocaleString()}
                  </p>
                  <p className="text-xs text-text-tertiary">Failed (DLQ)</p>
                </div>
              </div>

              <div className="mt-3 rounded-lg border border-border-primary bg-bg-secondary p-4">
                <div className="flex items-baseline justify-between">
                  <p className="text-xs font-medium text-text-secondary">
                    Waiting over time
                  </p>
                  {trend && (
                    <p className="text-[11px] text-text-tertiary">
                      {trend.delta === 0
                        ? "flat"
                        : trend.delta > 0
                          ? `+${trend.delta.toLocaleString()} jobs in ${trend.minutes.toFixed(1)}m`
                          : `${trend.delta.toLocaleString()} jobs in ${trend.minutes.toFixed(1)}m`}
                      <span className="ml-2">
                        ({trend.ratePerMin > 0 ? "+" : ""}
                        {trend.ratePerMin.toFixed(1)}/min
                        {trend.ratePerMin < 0 ? " — clearing" : trend.ratePerMin > 0 ? " — growing" : ""})
                      </span>
                    </p>
                  )}
                </div>
                <Sparkline
                  samples={samples}
                  field="waiting"
                  color="#25D366"
                />
                <p className="mt-1 text-[10px] text-text-tertiary">
                  Last {samples.length} samples (15s interval, max {MAX_SAMPLES}).
                  Resets on page reload.
                </p>
              </div>
            </>
          )}

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
