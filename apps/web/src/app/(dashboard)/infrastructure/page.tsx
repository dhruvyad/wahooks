"use client";

import { startTransition, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";
import { EventVolumeSection } from "./event-volume";

// CPU, memory and connections of a gateway server; null parts carry a reason in `errors`.
interface GatewayResources {
  sampledAt: string | null; // CPU and memory are sampled about once a minute
  server: { name: string; type: string } | null;
  cpu: { pct: number; avgPct5m: number; cores: number } | null; // % of the whole server
  memory: {
    usedBytes: number;
    totalBytes: number | null;
    pct: number | null;
    heapLiveBytes?: number;
  } | null;
  sessions: { current: number; max: number; pct: number | null }; // max 0 = no cap
  errors: { server?: string; cpu?: string; memory?: string };
}

interface Worker {
  id: string;
  podName: string;
  status: string;
  kind?: "waha" | "gateway";
  currentSessions: number; // live sessions — what counts toward capacity
  failedSessions: number; // present on the pod but idle, not counted
  maxSessions: number;
  utilization: number;
  resources?: GatewayResources | null; // active gateways only
}

interface WebhookQueue {
  waiting: number;
  active: number;
  delayed: number;
  failed: number; // failed jobs BullMQ keeps: stops at failedKept
  completed: number;
  reachable: boolean;
  failedKept?: number; // BullMQ's removeOnFail cap
  failedLast24h?: number | null; // deliveries given up on in the last 24 h; null when unreadable
}

interface InfraStatus {
  workers: Worker[];
  summary: {
    totalWorkers: number;
    drainingWorkers: number;
    totalCapacity: number;
    totalUsed: number;
    totalFailed: number;
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

/**
 * BullMQ keeps only the newest `failedKept` failed jobs, so the queue's failed
 * count stops there: a retention window, not a backlog. The deliveries given up
 * on in the last 24 h come from the event counters.
 */
function FailedJobsCard({ queue }: { queue: WebhookQueue }) {
  const kept = queue.failedKept;
  const last24h = queue.failedLast24h;
  return (
    <div
      className="rounded-lg border border-border-primary bg-bg-secondary p-4"
      title={
        kept
          ? `BullMQ keeps only the newest ${kept.toLocaleString()} failed jobs, so this count stops at ${kept.toLocaleString()}. It is a retention window, not a backlog.`
          : undefined
      }
    >
      <p className="text-2xl font-bold text-text-primary">{queue.failed.toLocaleString()}</p>
      <p className="text-xs text-text-tertiary">
        Failed jobs kept{kept ? ` (newest ${kept.toLocaleString()})` : ""}
      </p>
      {last24h !== undefined && (
        <p
          className={`mt-1 text-[11px] ${
            last24h ? "text-status-error-text" : "text-text-tertiary"
          }`}
        >
          {last24h === null ? "Failed in last 24h: unknown" : `${last24h.toLocaleString()} failed in last 24h`}
        </p>
      )}
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

function formatBytes(bytes: number): string {
  const MiB = 1024 ** 2;
  const GiB = 1024 ** 3;
  if (bytes >= GiB) return `${Number((bytes / GiB).toFixed(1)).toLocaleString()} GB`;
  if (bytes >= MiB) return `${Math.round(bytes / MiB).toLocaleString()} MB`;
  return `${Math.round(bytes / 1024).toLocaleString()} KB`;
}

function formatPct(pct: number): string {
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

/** A labelled bar: neutral under 60%, amber from 60%, red from 85%; empty when pct is null. */
function Meter({
  label,
  value,
  pct,
  detail,
  problem,
}: {
  label: string;
  value: string;
  pct: number | null;
  detail?: string;
  problem?: string;
}) {
  const color =
    pct === null
      ? ""
      : pct >= 85
        ? "bg-status-error-text"
        : pct >= 60
          ? "bg-status-warning-text"
          : "bg-status-neutral-text";
  const width = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-text-secondary">{label}</span>
        <span className="truncate text-text-primary tabular-nums" title={value}>
          {value}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-bg-elevated">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${width}%` }}
        />
      </div>
      {problem ? (
        <p className="mt-1 truncate text-[11px] text-status-warning-text" title={problem}>
          {problem}
        </p>
      ) : (
        detail && <p className="mt-1 truncate text-[11px] text-text-tertiary">{detail}</p>
      )}
    </div>
  );
}

/** A gateway's connections: the row counters from `resources`, or the live count before them. */
function gatewaySessions(w: Worker): { current: number; max: number; pct: number | null } {
  if (w.resources) return w.resources.sessions;
  const pct = w.maxSessions > 0 ? (w.currentSessions / w.maxSessions) * 100 : null;
  return { current: w.currentSessions, max: w.maxSessions, pct };
}

function connectionsText(s: { current: number; max: number; pct: number | null }): string {
  return s.max > 0
    ? `${s.current.toLocaleString()} / ${s.max.toLocaleString()} (${formatPct(s.pct ?? 0)})`
    : `${s.current.toLocaleString()} (no cap)`;
}

function GatewayCard({ w, now }: { w: Worker; now: number }) {
  const r = w.resources ?? null;
  const sessions = gatewaySessions(w);
  const sampledAgo =
    r?.sampledAt != null ? Math.max(0, Math.round((now - Date.parse(r.sampledAt)) / 1000)) : null;
  const waiting = r !== null && r.sampledAt === null;
  const unavailable = (reason?: string) =>
    waiting ? "Waiting for the first sample…" : r === null ? "Not sampled (gateway not active)" : reason;

  const mem = r?.memory ?? null;
  const memValue = mem
    ? mem.totalBytes !== null
      ? `${formatBytes(mem.usedBytes)} / ${formatBytes(mem.totalBytes)} (${formatPct(mem.pct ?? 0)})`
      : formatBytes(mem.usedBytes)
    : "—";
  const memDetail =
    mem?.heapLiveBytes !== undefined ? `Go live heap ${formatBytes(mem.heapLiveBytes)}` : undefined;

  const cpu = r?.cpu ?? null;

  return (
    <div className="rounded-lg border border-border-primary bg-bg-secondary p-4 transition-colors duration-150 hover:border-border-secondary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusDot status={w.status} />
          <span className="text-sm font-medium text-text-primary font-mono">{w.podName}</span>
          <span className="rounded-full bg-bg-elevated px-2 py-0.5 text-[10px] text-text-tertiary">
            {w.status}
          </span>
          {r?.server && (
            <span className="rounded-full bg-bg-elevated px-2 py-0.5 text-[10px] text-text-tertiary">
              {r.server.type}
              {r.server.name !== w.podName && (
                <span className="font-mono"> · {r.server.name}</span>
              )}
            </span>
          )}
        </div>
        {sampledAgo !== null && (
          <span className="text-[11px] text-text-tertiary">sampled {sampledAgo}s ago</span>
        )}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Meter
          label="Connections"
          value={connectionsText(sessions)}
          pct={sessions.max > 0 ? sessions.pct : null}
          detail={w.failedSessions > 0 ? `${w.failedSessions} failed (not counted)` : undefined}
        />
        <Meter
          label="Memory"
          value={memValue}
          pct={mem?.pct ?? null}
          detail={memDetail}
          problem={mem === null || mem.totalBytes === null ? unavailable(r?.errors.memory) : undefined}
        />
        <Meter
          label="CPU"
          value={cpu ? `${formatPct(cpu.pct)} of ${cpu.cores} cores` : "—"}
          pct={cpu?.pct ?? null}
          detail={cpu ? `5-min avg ${formatPct(cpu.avgPct5m)}` : undefined}
          problem={cpu === null ? unavailable(r?.errors.cpu) : undefined}
        />
      </div>
    </div>
  );
}

/** Connections and memory summed over the gateway fleet (capped servers / servers with a known size). */
function GatewayFleet({ gateways }: { gateways: Worker[] }) {
  const sessions = gateways.map(gatewaySessions);
  const capped = sessions.filter((s) => s.max > 0);
  const used = capped.reduce((sum, s) => sum + s.current, 0);
  const capacity = capped.reduce((sum, s) => sum + s.max, 0);
  const uncapped = sessions.filter((s) => s.max <= 0);
  const uncappedUsed = uncapped.reduce((sum, s) => sum + s.current, 0);

  const sized = gateways
    .map((w) => w.resources?.memory)
    .filter((m): m is NonNullable<GatewayResources["memory"]> => !!m && m.totalBytes !== null);
  const memUsed = sized.reduce((sum, m) => sum + m.usedBytes, 0);
  const memTotal = sized.reduce((sum, m) => sum + (m.totalBytes ?? 0), 0);
  const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : null;

  return (
    <div className="mt-2 rounded-lg border border-border-primary bg-bg-secondary p-4">
      <p className="text-xs font-medium text-text-secondary">
        Fleet total · {gateways.length} {gateways.length === 1 ? "server" : "servers"}
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <Meter
          label="Connections"
          value={
            capacity > 0
              ? connectionsText({ current: used, max: capacity, pct: (used / capacity) * 100 })
              : connectionsText({ current: uncappedUsed, max: 0, pct: null })
          }
          pct={capacity > 0 ? (used / capacity) * 100 : null}
          detail={
            capacity > 0 && uncapped.length > 0
              ? `+ ${uncappedUsed.toLocaleString()} on ${uncapped.length} with no cap`
              : undefined
          }
        />
        <Meter
          label="Memory"
          value={
            memPct !== null
              ? `${formatBytes(memUsed)} / ${formatBytes(memTotal)} (${formatPct(memPct)})`
              : "—"
          }
          pct={memPct}
          detail={
            sized.length > 0 && sized.length < gateways.length
              ? `${sized.length} of ${gateways.length} servers reporting`
              : undefined
          }
          problem={sized.length === 0 ? "No server is reporting memory yet" : undefined}
        />
      </div>
    </div>
  );
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

  // Gateway servers get CPU / memory / connection meters; WAHA pods (being retired) keep their card.
  const gateways = data?.workers.filter((w) => w.kind === "gateway") ?? [];
  const wahaWorkers = data?.workers.filter((w) => w.kind !== "gateway") ?? [];

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
              <p className="text-xs text-text-tertiary">
                Live sessions
                {data.summary.totalFailed > 0 && (
                  <span className="text-status-warning-text">
                    {" "}· {data.summary.totalFailed} failed
                  </span>
                )}
              </p>
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

          {/* Events received and webhook deliveries over time (server-side counters) */}
          <EventVolumeSection />

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
                <FailedJobsCard queue={data.webhookQueue} />
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

          {/* Gateway servers */}
          {gateways.length > 0 && (
            <>
              <h2 className="mt-6 text-sm font-semibold text-text-primary">
                Gateway Servers
              </h2>
              <GatewayFleet gateways={gateways} />
              <div className="mt-2 space-y-2">
                {gateways.map((w) => (
                  <GatewayCard key={w.id} w={w} now={Date.parse(data.timestamp)} />
                ))}
              </div>
            </>
          )}

          {/* WAHA workers */}
          {(gateways.length === 0 || wahaWorkers.length > 0) && (
            <>
              <h2 className="mt-6 text-sm font-semibold text-text-primary">
                {gateways.length > 0 ? "WAHA Workers" : "Workers"}
              </h2>
              <div className="mt-2 space-y-2">
                {wahaWorkers.length === 0 ? (
                  <p className="text-sm text-text-tertiary">No active workers</p>
                ) : (
                  wahaWorkers.map((w) => (
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
                          {w.failedSessions > 0 && (
                            <span className="text-status-warning-text">
                              {" "}· {w.failedSessions} failed
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="mt-2">
                        <UtilizationBar value={w.currentSessions} max={w.maxSessions} />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

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
            {gateways.length > 0 && "; gateway CPU and memory are sampled about once a minute"}
          </p>
        </>
      )}
    </div>
  );
}
