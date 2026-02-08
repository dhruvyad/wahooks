const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  working: { label: "Connected", className: "bg-status-success-bg text-status-success-text" },
  scan_qr: { label: "Scan QR", className: "bg-status-warning-bg text-status-warning-text" },
  pending: { label: "Pending", className: "bg-status-neutral-bg text-status-neutral-text" },
  failed: { label: "Failed", className: "bg-status-error-bg text-status-error-text" },
  stopped: { label: "Stopped", className: "bg-status-neutral-bg text-status-neutral-text" },
};

export function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || {
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
