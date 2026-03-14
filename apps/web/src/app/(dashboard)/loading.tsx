export default function DashboardLoading() {
  return (
    <div className="animate-fade-in">
      <div className="h-8 w-48 animate-pulse rounded-lg bg-bg-elevated" />
      <div className="mt-2 h-4 w-72 animate-pulse rounded bg-bg-elevated" />
      <div className="mt-6 space-y-3">
        <div className="h-20 animate-pulse rounded-xl bg-bg-elevated" />
        <div className="h-20 animate-pulse rounded-xl bg-bg-elevated" />
        <div className="h-20 animate-pulse rounded-xl bg-bg-elevated" />
      </div>
    </div>
  );
}
