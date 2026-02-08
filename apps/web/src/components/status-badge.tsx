const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  working: { label: "Connected", className: "bg-green-100 text-green-700" },
  scan_qr: { label: "Scan QR", className: "bg-yellow-100 text-yellow-700" },
  pending: { label: "Pending", className: "bg-gray-100 text-gray-600" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700" },
  stopped: { label: "Stopped", className: "bg-gray-100 text-gray-600" },
};

export function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || {
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
