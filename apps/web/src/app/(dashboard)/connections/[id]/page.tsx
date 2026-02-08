"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";
import { WebhookList } from "@/components/webhook-list";

interface Connection {
  id: string;
  name: string | null;
  status: string;
  me: { id: string; pushName?: string } | null;
}

interface QrData {
  value: string;
  mimetype: string;
}

export default function ConnectionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [qr, setQr] = useState<QrData | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  const [restarting, setRestarting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const connectionRef = useRef<Connection | null>(null);
  connectionRef.current = connection;

  const fetchConnection = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/connections/${id}`);
      setConnection(data);
      setError(null);
      return data as Connection;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load connection");
      return null;
    }
  }, [id]);

  const fetchQr = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/connections/${id}/qr`);
      setQr(data);
      setQrError(null);
    } catch (err) {
      setQrError(
        err instanceof Error ? err.message : "Failed to load QR code"
      );
    }
  }, [id]);

  useEffect(() => {
    fetchConnection().finally(() => setLoading(false));
  }, [fetchConnection]);

  useEffect(() => {
    const interval = setInterval(() => {
      const current = connectionRef.current;
      if (
        current &&
        (current.status === "scan_qr" || current.status === "pending")
      ) {
        fetchConnection();
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [fetchConnection]);

  useEffect(() => {
    if (!connection) return;

    if (connection.status === "scan_qr" || connection.status === "pending") {
      fetchQr();

      const interval = setInterval(() => {
        fetchQr();
      }, 5000);

      return () => clearInterval(interval);
    } else {
      setQr(null);
      setQrError(null);
    }
  }, [connection?.status, fetchQr, connection]);

  async function handleRestart() {
    setRestarting(true);
    try {
      await apiFetch(`/api/connections/${id}/restart`, { method: "POST" });
      await fetchConnection();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to restart connection"
      );
    } finally {
      setRestarting(false);
    }
  }

  async function handleDelete() {
    const confirmed = window.confirm(
      "Are you sure you want to delete this connection? This action cannot be undone."
    );
    if (!confirmed) return;

    setDeleting(true);
    try {
      await apiFetch(`/api/connections/${id}`, { method: "DELETE" });
      router.push("/connections");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to delete connection"
      );
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div>
        <Link
          href="/connections"
          className="text-sm text-text-secondary hover:text-wa-green"
        >
          &larr; Back to Connections
        </Link>
        <div className="mt-12 text-center">
          <p className="text-text-secondary">Loading connection...</p>
        </div>
      </div>
    );
  }

  if (error && !connection) {
    return (
      <div>
        <Link
          href="/connections"
          className="text-sm text-text-secondary hover:text-wa-green"
        >
          &larr; Back to Connections
        </Link>
        <div className="mt-6 rounded-md border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div>
      <Link
        href="/connections"
        className="text-sm text-text-secondary hover:text-wa-green"
      >
        &larr; Back to Connections
      </Link>

      <div className="mt-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary">
          {connection?.name || "Unnamed Connection"}
        </h1>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="rounded-md border border-status-error-border px-4 py-2 text-sm font-medium text-status-error-text hover:bg-status-error-bg disabled:opacity-50 transition-colors"
        >
          {deleting ? "Deleting..." : "Delete"}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          {error}
        </div>
      )}

      <div className="mt-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-secondary">Status:</span>
          <StatusBadge status={connection?.status ?? "pending"} />
        </div>

        <div>
          <span className="text-sm font-medium text-text-secondary">ID:</span>
          <span className="ml-2 text-sm text-text-tertiary">{id}</span>
        </div>
      </div>

      {/* QR Code section */}
      {(connection?.status === "scan_qr" ||
        connection?.status === "pending") && (
        <div className="mt-8 rounded-md border border-border-secondary p-6">
          <h2 className="text-lg font-semibold text-text-primary">Scan QR Code</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Open WhatsApp on your phone and scan this QR code to connect.
          </p>

          <div className="mt-4">
            {qrError && (
              <div className="rounded-md border border-status-warning-border bg-status-warning-bg p-4 text-sm text-status-warning-text">
                {connection.status === "pending"
                  ? "Waiting for QR code to be generated..."
                  : `Failed to load QR code: ${qrError}`}
              </div>
            )}

            {qr && (
              <div className="flex justify-center">
                <img
                  src={`data:${qr.mimetype};base64,${qr.value}`}
                  alt="WhatsApp QR Code"
                  className="h-64 w-64 rounded-md"
                />
              </div>
            )}

            {!qr && !qrError && (
              <div className="flex h-64 w-64 items-center justify-center mx-auto rounded-md border border-border-primary bg-bg-secondary">
                <p className="text-sm text-text-tertiary">Loading QR code...</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Connected section */}
      {connection?.status === "working" && (
        <div className="mt-8 rounded-md border border-status-success-border bg-status-success-bg p-6">
          <h2 className="text-lg font-semibold text-status-success-text">Connected</h2>
          {connection.me?.id && (
            <p className="mt-1 text-sm text-status-success-text">
              Phone: {connection.me.id.replace("@c.us", "")}
              {connection.me.pushName && ` (${connection.me.pushName})`}
            </p>
          )}
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="mt-4 rounded-md border border-status-success-border bg-bg-primary px-4 py-2 text-sm font-medium text-status-success-text hover:bg-bg-hover disabled:opacity-50 transition-colors"
          >
            {restarting ? "Restarting..." : "Restart"}
          </button>
        </div>
      )}

      {/* Failed section */}
      {connection?.status === "failed" && (
        <div className="mt-8 rounded-md border border-status-error-border bg-status-error-bg p-6">
          <h2 className="text-lg font-semibold text-status-error-text">
            Connection Failed
          </h2>
          <p className="mt-1 text-sm text-status-error-text">
            Something went wrong with this connection. Try restarting it.
          </p>
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="mt-4 rounded-md border border-status-error-border bg-bg-primary px-4 py-2 text-sm font-medium text-status-error-text hover:bg-bg-hover disabled:opacity-50 transition-colors"
          >
            {restarting ? "Restarting..." : "Restart"}
          </button>
        </div>
      )}

      {/* Webhooks section */}
      <WebhookList connectionId={id} />
    </div>
  );
}
