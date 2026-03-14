"use client";

function Pulse({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-bg-elevated ${className ?? ""}`}
    />
  );
}

export function ConnectionCardSkeleton() {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border-primary bg-bg-secondary px-5 py-4">
      <div className="flex items-center gap-3">
        <div>
          <Pulse className="h-4 w-36" />
          <Pulse className="mt-2 h-3 w-24" />
        </div>
        <Pulse className="h-5 w-16 rounded-full" />
      </div>
      <Pulse className="h-4 w-4" />
    </div>
  );
}

export function ConnectionListSkeleton() {
  return (
    <div className="mt-6 space-y-2">
      <ConnectionCardSkeleton />
      <ConnectionCardSkeleton />
      <ConnectionCardSkeleton />
    </div>
  );
}

export function ConnectionDetailSkeleton() {
  return (
    <div>
      <div className="mt-6 flex items-start justify-between gap-4">
        <div>
          <Pulse className="h-7 w-48" />
          <div className="mt-2 flex items-center gap-3">
            <Pulse className="h-5 w-20 rounded-full" />
            <Pulse className="h-4 w-56" />
          </div>
        </div>
        <Pulse className="h-8 w-16 rounded-lg" />
      </div>
      <div className="mt-8 rounded-xl border border-border-primary bg-bg-secondary p-6">
        <Pulse className="h-5 w-32" />
        <Pulse className="mt-3 h-4 w-64" />
        <Pulse className="mt-4 h-48 w-full" />
      </div>
    </div>
  );
}

export function WebhookRowSkeleton() {
  return (
    <div className="rounded-xl border border-border-primary bg-bg-secondary p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <Pulse className="h-4 w-56" />
          <div className="mt-2 flex gap-1.5">
            <Pulse className="h-5 w-16 rounded-full" />
            <Pulse className="h-5 w-20 rounded-full" />
            <Pulse className="h-5 w-14 rounded-full" />
          </div>
          <Pulse className="mt-2 h-3 w-40" />
        </div>
        <div className="flex items-center gap-2">
          <Pulse className="h-6 w-11 rounded-full" />
          <Pulse className="h-7 w-14 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

export function WebhookListSkeleton() {
  return (
    <div className="mt-4 space-y-3">
      <WebhookRowSkeleton />
      <WebhookRowSkeleton />
    </div>
  );
}

export function TokenRowSkeleton() {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border-primary bg-bg-secondary px-5 py-4">
      <div className="flex-1">
        <Pulse className="h-4 w-32" />
        <div className="mt-2 flex items-center gap-4">
          <Pulse className="h-3 w-20" />
          <Pulse className="h-3 w-28" />
          <Pulse className="h-3 w-28" />
        </div>
      </div>
      <Pulse className="h-7 w-16 rounded-lg" />
    </div>
  );
}

export function TokenListSkeleton() {
  return (
    <div className="mt-6 space-y-2">
      <TokenRowSkeleton />
      <TokenRowSkeleton />
      <TokenRowSkeleton />
    </div>
  );
}

export function BillingSkeleton() {
  return (
    <div className="mt-6 space-y-4">
      <div className="rounded-xl border border-border-primary bg-bg-secondary p-6">
        <Pulse className="h-5 w-28" />
        <Pulse className="mt-3 h-4 w-64" />
        <Pulse className="mt-4 h-9 w-36 rounded-lg" />
      </div>
      <div className="rounded-xl border border-border-primary bg-bg-secondary p-6">
        <Pulse className="h-5 w-40" />
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-border-primary bg-bg-elevated p-4">
            <Pulse className="h-3 w-24" />
            <Pulse className="mt-2 h-7 w-16" />
          </div>
          <div className="rounded-lg border border-border-primary bg-bg-elevated p-4">
            <Pulse className="h-3 w-28" />
            <Pulse className="mt-2 h-7 w-8" />
          </div>
          <div className="rounded-lg border border-border-primary bg-bg-elevated p-4">
            <Pulse className="h-3 w-24" />
            <Pulse className="mt-2 h-7 w-16" />
          </div>
        </div>
      </div>
    </div>
  );
}
