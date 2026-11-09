"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";

// GET /api/infrastructure/events: per-minute counters in Redis, bucketed server-side.
export type EventRange = "1h" | "24h" | "7d";

interface EventCounts {
  received: number; // events accepted for a known connection
  messages: number; // the `message` events among them
  delivered: number; // webhook deliveries that succeeded
  failed: number; // deliveries whose final attempt failed
  retried: number; // failed attempts that were retried
}

interface EventBucket extends EventCounts {
  t: string; // bucket start
}

export interface EventVolume {
  range: EventRange;
  bucketSeconds: number;
  from: string;
  to: string;
  available: boolean; // false: Redis couldn't be read
  buckets: EventBucket[];
  totals: EventCounts;
  ratePerMinute: number | null; // received per minute, last 5 complete minutes
  dataSince: string | null; // first bucket with any count
  byType: { since: string; types: { type: string; count: number }[] };
}

const RANGES: { id: EventRange; label: string; long: string }[] = [
  { id: "1h", label: "1h", long: "last hour" },
  { id: "24h", label: "24h", long: "last 24 hours" },
  { id: "7d", label: "7d", long: "last 7 days" },
];

// Dark-surface categorical steps; each chart's pair is validated for colour-vision deficiency.
const BLUE = "#3987e5";
const MAGENTA = "#d55181";
const AQUA = "#199e70";
const ORANGE = "#d95926";
const GRID = "#2a2a2a";

interface Series {
  key: keyof EventCounts;
  label: string;
  color: string;
  area?: boolean;
}

const EVENT_SERIES: Series[] = [
  { key: "received", label: "Received", color: BLUE, area: true },
  { key: "messages", label: "Messages", color: MAGENTA },
];
const DELIVERY_SERIES: Series[] = [
  { key: "delivered", label: "Delivered", color: AQUA, area: true },
  { key: "failed", label: "Failed", color: ORANGE },
];

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** Full under 10,000, compact above (12.3K). */
export function formatCount(n: number): string {
  return Math.abs(n) < 10_000 ? Math.round(n).toLocaleString() : compact.format(n);
}

function formatRate(n: number): string {
  return n < 10 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : formatCount(n);
}

/** Axis ticks at round steps (1, 2, 5 x 10^k), from 0 to at least `max`. */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return ticks;
}

function bucketLabel(t: string, bucketSeconds: number): string {
  const start = new Date(t);
  const end = new Date(start.getTime() + bucketSeconds * 1000);
  const time = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (bucketSeconds >= 3600) {
    return `${start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${time(start)}–${time(end)}`;
  }
  return bucketSeconds === 60 ? time(start) : `${time(start)}–${time(end)}`;
}

/** X-axis ticks: every 15 min (1h), every 6 h (24h), each midnight (7d), in local time. */
function xTicks(buckets: EventBucket[], range: EventRange): { i: number; label: string }[] {
  const ticks: { i: number; label: string }[] = [];
  buckets.forEach((b, i) => {
    const d = new Date(b.t);
    const m = d.getMinutes();
    const h = d.getHours();
    let label: string | null = null;
    if (range === "1h" && m % 15 === 0) {
      label = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } else if (range === "24h" && m === 0 && h % 6 === 0) {
      label = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } else if (range === "7d" && h === 0) {
      label = d.toLocaleDateString([], { month: "short", day: "numeric" });
    }
    if (label) ticks.push({ i, label });
  });
  const n = buckets.length;
  // Keep labels off the very edges, where they'd be cut in half.
  return ticks.filter(({ i }) => i / Math.max(n - 1, 1) > 0.04 && i / Math.max(n - 1, 1) < 0.96);
}

const VB_W = 1000;
const VB_H = 100;

/** SVG coordinates of each bucket's value, in a 1000 x 100 box stretched over the plot. */
function points(values: number[], top: number): string[] {
  const n = values.length;
  return values.map((v, i) => {
    const x = (i / Math.max(n - 1, 1)) * VB_W;
    const y = VB_H - (v / top) * VB_H;
    return `${x.toFixed(1)},${y.toFixed(2)}`;
  });
}

const path = (pts: string[]) => (pts.length ? `M${pts.join("L")}` : "");

/**
 * A line chart over the buckets: one y-axis from 0, hairline grid, a crosshair
 * and tooltip on hover (arrow keys when focused). Buckets before `start` (the
 * first one with any count) aren't drawn: nothing was counted yet, which isn't
 * the same as zero. The last bucket is still filling, so its segment is faint.
 */
function TimeSeriesChart({
  buckets,
  start,
  series,
  range,
  bucketSeconds,
  label,
  extraRows,
}: {
  buckets: EventBucket[];
  start: number;
  series: Series[];
  range: EventRange;
  bucketSeconds: number;
  label: string;
  extraRows?: { key: keyof EventCounts; label: string }[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const tooltipId = useId();
  const n = buckets.length;
  const first = Math.min(Math.max(start, 0), n - 1);
  const max = Math.max(0, ...buckets.flatMap((b) => series.map((s) => b[s.key])));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  // One number style per axis: compact throughout once it reaches 10,000.
  const tickLabel = (v: number) => (top >= 10_000 ? compact.format(v) : v.toLocaleString());
  const xPct = (i: number) => (i / Math.max(n - 1, 1)) * 100;
  const yPct = (v: number) => 100 - (v / top) * 100;
  const clamp = (i: number) => Math.min(n - 1, Math.max(first, i));

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / Math.max(rect.width, 1);
    setHover(clamp(Math.round(frac * (n - 1))));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    setHover((h) => {
      const cur = h ?? n - 1;
      if (e.key === "Home") return first;
      if (e.key === "End") return n - 1;
      return clamp(cur + (e.key === "ArrowLeft" ? -1 : 1));
    });
  };

  const hovered = hover !== null ? buckets[hover] : null;

  return (
    <div>
      <div className="flex">
        {/* y-axis labels */}
        <div className="relative w-10 shrink-0 text-[10px] tabular-nums text-text-tertiary">
          {ticks.map((v) => (
            <span
              key={v}
              className="absolute right-2 -translate-y-1/2 leading-none"
              style={{ top: `${yPct(v)}%` }}
            >
              {tickLabel(v)}
            </span>
          ))}
        </div>
        <div
          className="relative h-36 flex-1 cursor-crosshair touch-pan-y rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-border-accent"
          tabIndex={0}
          role="img"
          aria-label={label}
          aria-describedby={hovered ? tooltipId : undefined}
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover((h) => h ?? n - 1)}
          onBlur={() => setHover(null)}
          onKeyDown={onKey}
        >
          <svg
            viewBox={`0 -1 ${VB_W} ${VB_H + 2}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible"
            aria-hidden
          >
            {ticks.map((v) => (
              <line
                key={v}
                x1={0}
                x2={VB_W}
                y1={VB_H - (v / top) * VB_H}
                y2={VB_H - (v / top) * VB_H}
                stroke={GRID}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {series.map((s) => {
              const pts = points(buckets.map((b) => b[s.key]), top).slice(first);
              const x0 = ((first / Math.max(n - 1, 1)) * VB_W).toFixed(1);
              // The last bucket is still filling: its segment is drawn faint.
              const tail = pts.length >= 2 ? path(pts.slice(-2)) : "";
              return (
                <g key={s.key}>
                  {s.area && pts.length >= 2 && (
                    <path
                      d={`${path(pts)}L${VB_W},${VB_H}L${x0},${VB_H}Z`}
                      fill={s.color}
                      fillOpacity={0.1}
                    />
                  )}
                  <path
                    d={path(pts.slice(0, Math.max(pts.length - 1, 1)))}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                  {tail && (
                    <path
                      d={tail}
                      fill="none"
                      stroke={s.color}
                      strokeOpacity={0.4}
                      strokeWidth={2}
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                </g>
              );
            })}
          </svg>

          {hovered && hover !== null && (
            <>
              <div
                className="pointer-events-none absolute inset-y-0 w-px bg-border-secondary"
                style={{ left: `${xPct(hover)}%` }}
              />
              {series.map((s) => (
                <span
                  key={s.key}
                  className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-bg-secondary"
                  style={{ left: `${xPct(hover)}%`, top: `${yPct(hovered[s.key])}%`, background: s.color }}
                />
              ))}
              <div
                id={tooltipId}
                role="status"
                className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-md border border-border-secondary bg-bg-tertiary px-2.5 py-2 text-xs shadow-lg"
                style={
                  xPct(hover) > 55
                    ? { right: `${100 - xPct(hover) + 2}%` }
                    : { left: `${xPct(hover) + 2}%` }
                }
              >
                <p className="text-[11px] text-text-tertiary">
                  {bucketLabel(hovered.t, bucketSeconds)}
                  {hover === n - 1 && " (in progress)"}
                </p>
                {series.map((s) => (
                  <p key={s.key} className="mt-1 flex items-center gap-2">
                    <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                    <span className="font-semibold tabular-nums text-text-primary">
                      {hovered[s.key].toLocaleString()}
                    </span>
                    <span className="text-text-secondary">{s.label}</span>
                  </p>
                ))}
                {extraRows?.map((r) => (
                  <p key={r.key} className="mt-1 flex items-center gap-2">
                    <span className="w-3" />
                    <span className="font-semibold tabular-nums text-text-primary">
                      {hovered[r.key].toLocaleString()}
                    </span>
                    <span className="text-text-secondary">{r.label}</span>
                  </p>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {/* x-axis labels */}
      <div className="relative ml-10 h-5 text-[10px] tabular-nums text-text-tertiary">
        {xTicks(buckets, range).map(({ i, label: tick }) => (
          <span
            key={i}
            className="absolute top-1.5 -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${xPct(i)}%` }}
          >
            {tick}
          </span>
        ))}
      </div>
    </div>
  );
}

function Legend({ series, totals }: { series: Series[]; totals: EventCounts }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
          <span className="text-text-secondary">{s.label}</span>
          <span className="tabular-nums text-text-primary">{totals[s.key].toLocaleString()}</span>
        </span>
      ))}
    </div>
  );
}

function StatTile({ value, label, detail }: { value: string; label: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-border-primary bg-bg-secondary p-4">
      <p className="text-2xl font-bold text-text-primary">{value}</p>
      <p className="text-xs text-text-tertiary">{label}</p>
      {detail && <p className="mt-1 truncate text-[11px] text-text-tertiary">{detail}</p>}
    </div>
  );
}

function shortTime(iso: string, range: EventRange): string {
  const d = new Date(iso);
  return range === "1h"
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** The data behind both charts, newest first, for reading without hovering. */
function BucketTable({ volume }: { volume: EventVolume }) {
  const rows = volume.buckets.filter((b) => b.received + b.delivered + b.failed + b.retried > 0).reverse();
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-text-tertiary hover:text-text-secondary">
        Show as table ({rows.length} {rows.length === 1 ? "bucket" : "buckets"} with counts)
      </summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-md border border-border-primary">
        <table className="w-full text-left tabular-nums">
          <thead className="sticky top-0 bg-bg-tertiary text-text-tertiary">
            <tr>
              <th className="px-2 py-1.5 font-medium">Bucket</th>
              <th className="px-2 py-1.5 text-right font-medium">Received</th>
              <th className="px-2 py-1.5 text-right font-medium">Messages</th>
              <th className="px-2 py-1.5 text-right font-medium">Delivered</th>
              <th className="px-2 py-1.5 text-right font-medium">Failed</th>
              <th className="px-2 py-1.5 text-right font-medium">Retries</th>
            </tr>
          </thead>
          <tbody className="text-text-secondary">
            {rows.map((b) => (
              <tr key={b.t} className="border-t border-border-primary">
                <td className="px-2 py-1">{bucketLabel(b.t, volume.bucketSeconds)}</td>
                <td className="px-2 py-1 text-right">{b.received.toLocaleString()}</td>
                <td className="px-2 py-1 text-right">{b.messages.toLocaleString()}</td>
                <td className="px-2 py-1 text-right">{b.delivered.toLocaleString()}</td>
                <td className="px-2 py-1 text-right">{b.failed.toLocaleString()}</td>
                <td className="px-2 py-1 text-right">{b.retried.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function TopTypes({ volume }: { volume: EventVolume }) {
  const { types, since } = volume.byType;
  const total = types.reduce((s, t) => s + t.count, 0);
  if (total === 0) return null;
  const shown = types.slice(0, 4);
  const pct = (c: number) => {
    const p = (c / total) * 100;
    return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
  };
  return (
    <p className="mt-2 text-[11px] text-text-tertiary">
      By type since {shortTime(since, volume.range)}:{" "}
      {shown.map((t, i) => (
        <span key={t.type}>
          {i > 0 && " · "}
          <span className="font-mono text-text-secondary">{t.type}</span> {pct(t.count)}
        </span>
      ))}
      {types.length > shown.length && ` · ${types.length - shown.length} more`}
    </p>
  );
}

const CHART_CARD = "rounded-lg border border-border-primary bg-bg-secondary p-4";

/** Events received and webhook deliveries over 1h / 24h / 7d, from the server's per-minute counters. */
export function EventVolumeSection() {
  const [range, setRange] = useState<EventRange>("1h");
  const { data, error } = useApiData<EventVolume>(
    `infrastructure-events-${range}`,
    () => apiFetch(`/api/infrastructure/events?range=${range}`),
    { revalidateInterval: range === "1h" ? 30_000 : 60_000 }
  );
  // While another range loads, keep the previous one on screen, dimmed.
  const current = data?.range === range ? data : null;
  const volume = current ?? data;
  const long = RANGES.find((r) => r.id === range)!.long;

  const start = volume?.dataSince ? volume.buckets.findIndex((b) => b.t === volume.dataSince) : 0;
  const t = volume?.totals;
  const outcomes = t ? t.delivered + t.failed : 0;
  const successPct = t && outcomes > 0 ? (t.delivered / outcomes) * 100 : null;

  return (
    <section>
      <h2 className="mt-6 text-sm font-semibold text-text-primary">Event Volume</h2>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-border-primary bg-bg-secondary p-0.5" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={range === r.id}
              onClick={() => setRange(r.id)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors duration-150 ${
                range === r.id
                  ? "bg-bg-elevated text-text-primary"
                  : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        {volume?.available && volume.dataSince && volume.dataSince > volume.from && (
          <span className="text-[11px] text-text-tertiary">
            First counts in this range: {shortTime(volume.dataSince, range)}
          </span>
        )}
      </div>

      {!volume ? (
        error ? (
          <p className="mt-2 text-sm text-status-error-text">Couldn&apos;t load event volume: {error}</p>
        ) : (
          <div className="mt-2 h-72 animate-pulse rounded-lg bg-bg-elevated" />
        )
      ) : !volume.available ? (
        <p className="mt-2 text-sm text-status-error-text">
          Event counts unavailable (Redis read failed)
        </p>
      ) : (
        <div className={`transition-opacity duration-200 ${current ? "" : "opacity-50"}`}>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile
              value={volume.ratePerMinute === null ? "—" : formatRate(volume.ratePerMinute)}
              label="Events per minute now"
              detail="Average of the last 5 full minutes"
            />
            <StatTile
              value={formatCount(volume.totals.received)}
              label={`Received, ${long}`}
              detail={`${volume.totals.messages.toLocaleString()} of them messages`}
            />
            <StatTile
              value={
                successPct === null
                  ? "—"
                  : successPct > 99.9 && successPct < 100
                    ? ">99.9%"
                    : `${Number(successPct.toFixed(successPct >= 99 ? 1 : 0))}%`
              }
              label={`Delivery success, ${long}`}
              detail={
                outcomes > 0
                  ? `${volume.totals.failed.toLocaleString()} failed of ${outcomes.toLocaleString()} · ${volume.totals.retried.toLocaleString()} retries`
                  : "No webhook deliveries finished"
              }
            />
          </div>

          {volume.dataSince === null ? (
            <div className={`mt-3 flex h-56 flex-col items-center justify-center gap-1 px-6 text-center ${CHART_CARD}`}>
              <p className="text-sm text-text-secondary">No events counted in the {long} yet</p>
              <p className="max-w-sm text-xs text-text-tertiary">
                Counting started with this release. The graphs fill in as events arrive.
              </p>
            </div>
          ) : (
            <>
              <div className={`mt-3 ${CHART_CARD}`}>
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-xs font-medium text-text-secondary">Events received</p>
                  <Legend series={EVENT_SERIES} totals={volume.totals} />
                </div>
                <TimeSeriesChart
                  buckets={volume.buckets}
                  start={start}
                  series={EVENT_SERIES}
                  range={volume.range}
                  bucketSeconds={volume.bucketSeconds}
                  label={`Events received per ${volume.bucketSeconds / 60}-minute bucket over the ${long}: ${volume.totals.received.toLocaleString()} in total, ${volume.totals.messages.toLocaleString()} messages`}
                />
                <TopTypes volume={volume} />
              </div>

              <div className={`mt-3 ${CHART_CARD}`}>
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-xs font-medium text-text-secondary">Webhook deliveries</p>
                  <Legend series={DELIVERY_SERIES} totals={volume.totals} />
                </div>
                <TimeSeriesChart
                  buckets={volume.buckets}
                  start={start}
                  series={DELIVERY_SERIES}
                  range={volume.range}
                  bucketSeconds={volume.bucketSeconds}
                  extraRows={[{ key: "retried", label: "Retries" }]}
                  label={`Webhook deliveries per ${volume.bucketSeconds / 60}-minute bucket over the ${long}: ${volume.totals.delivered.toLocaleString()} delivered, ${volume.totals.failed.toLocaleString()} failed`}
                />
                <p className="mt-2 text-[11px] text-text-tertiary">
                  Failed: given up after the last attempt. Retries: failed attempts that were tried again.
                </p>
              </div>

              <BucketTable volume={volume} />
            </>
          )}
        </div>
      )}
    </section>
  );
}
