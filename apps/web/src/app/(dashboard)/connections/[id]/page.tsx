"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";

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

  // Use refs to hold the latest connection status for interval callbacks
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

  // Initial load
  useEffect(() => {
    fetchConnection().finally(() => setLoading(false));
  }, [fetchConnection]);

  // Poll connection status every 3 seconds when in scan_qr or pending state
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

  // Fetch QR and poll every 5 seconds when in scan_qr or pending state
  useEffect(() => {
    if (!connection) return;

    if (connection.status === "scan_qr" || connection.status === "pending") {
      // Fetch QR immediately
      fetchQr();

      const interval = setInterval(() => {
        fetchQr();
      }, 5000);

      return () => clearInterval(interval);
    } else {
      // Clear QR data when not in scan state
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
          className="text-sm text-gray-500 hover:text-black"
        >
          &larr; Back to Connections
        </Link>
        <div className="mt-12 text-center">
          <p className="text-gray-500">Loading connection...</p>
        </div>
      </div>
    );
  }

  if (error && !connection) {
    return (
      <div>
        <Link
          href="/connections"
          className="text-sm text-gray-500 hover:text-black"
        >
          &larr; Back to Connections
        </Link>
        <div className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div>
      <Link
        href="/connections"
        className="text-sm text-gray-500 hover:text-black"
      >
        &larr; Back to Connections
      </Link>

      <div className="mt-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          {connection?.name || "Unnamed Connection"}
        </h1>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
        >
          {deleting ? "Deleting..." : "Delete"}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-700">Status:</span>
          <StatusBadge status={connection?.status ?? "pending"} />
        </div>

        <div>
          <span className="text-sm font-medium text-gray-700">ID:</span>
          <span className="ml-2 text-sm text-gray-500">{id}</span>
        </div>
      </div>

      {/* QR Code section — shown when status is scan_qr or pending */}
      {(connection?.status === "scan_qr" ||
        connection?.status === "pending") && (
        <div className="mt-8 rounded-md border border-gray-200 p-6">
          <h2 className="text-lg font-semibold">Scan QR Code</h2>
          <p className="mt-1 text-sm text-gray-500">
            Open WhatsApp on your phone and scan this QR code to connect.
          </p>

          <div className="mt-4">
            {qrError && (
              <div className="rounded-md border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-700">
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
                  className="h-64 w-64"
                />
              </div>
            )}

            {!qr && !qrError && (
              <div className="flex h-64 w-64 items-center justify-center mx-auto rounded-md border border-gray-200 bg-gray-50">
                <p className="text-sm text-gray-400">Loading QR code...</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Connected section — shown when status is working */}
      {connection?.status === "working" && (
        <div className="mt-8 rounded-md border border-green-200 bg-green-50 p-6">
          <h2 className="text-lg font-semibold text-green-800">Connected</h2>
          {connection.me?.id && (
            <p className="mt-1 text-sm text-green-700">
              Phone: {connection.me.id.replace("@c.us", "")}
              {connection.me.pushName && ` (${connection.me.pushName})`}
            </p>
          )}
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="mt-4 rounded-md border border-green-300 bg-white px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-100 disabled:opacity-50"
          >
            {restarting ? "Restarting..." : "Restart"}
          </button>
        </div>
      )}

      {/* Failed section */}
      {connection?.status === "failed" && (
        <div className="mt-8 rounded-md border border-red-200 bg-red-50 p-6">
          <h2 className="text-lg font-semibold text-red-800">
            Connection Failed
          </h2>
          <p className="mt-1 text-sm text-red-700">
            Something went wrong with this connection. Try restarting it.
          </p>
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="mt-4 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            {restarting ? "Restarting..." : "Restart"}
          </button>
        </div>
      )}
    </div>
  );
}
