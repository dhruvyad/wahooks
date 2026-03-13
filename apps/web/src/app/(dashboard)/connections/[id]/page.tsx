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

interface ChatItem {
  id: string;
  name?: string;
  timestamp: number;
  lastMessage?: { body: string; timestamp: number; fromMe: boolean };
}

interface WaProfile {
  id: string;
  pushName: string;
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

  const [chats, setChats] = useState<ChatItem[]>([]);
  const [profile, setProfile] = useState<WaProfile | null>(null);

  const connectionRef = useRef<Connection | null>(null);
  connectionRef.current = connection;

  const fetchConnection = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/connections/${id}`);
      setConnection(data);
      setError(null);
      return data as Connection;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load connection"
      );
      return null;
    }
  }, [id]);

  const fetchQr = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/connections/${id}/qr`);
      if (data.connected) {
        setConnection((prev) =>
          prev ? { ...prev, status: "working" } : prev
        );
        setQr(null);
        setQrError(null);
        return;
      }
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
    }, 2000);

    return () => clearInterval(interval);
  }, [fetchConnection]);

  useEffect(() => {
    if (!connection) return;

    if (connection.status === "scan_qr" || connection.status === "pending") {
      fetchQr();

      const interval = setInterval(() => {
        fetchQr();
      }, 3000);

      return () => clearInterval(interval);
    } else {
      setQr(null);
      setQrError(null);
    }
  }, [connection?.status, fetchQr, connection]);

  useEffect(() => {
    if (connection?.status !== "working") return;

    async function fetchConnectedData() {
      const [meData, chatsData] = await Promise.all([
        apiFetch(`/api/connections/${id}/me`).catch(() => null),
        apiFetch(`/api/connections/${id}/chats`).catch(() => []),
      ]);
      if (meData) setProfile(meData);
      setChats(chatsData ?? []);
    }

    fetchConnectedData();
  }, [connection?.status, id]);

  async function handleRestart() {
    setRestarting(true);
    setConnection((prev) => (prev ? { ...prev, status: "scan_qr" } : prev));
    setChats([]);
    setProfile(null);
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

  function handleDelete() {
    const confirmed = window.confirm(
      "Are you sure you want to delete this connection? This action cannot be undone."
    );
    if (!confirmed) return;

    router.push("/connections");
    apiFetch(`/api/connections/${id}`, { method: "DELETE" }).catch(() => {});
  }

  const backLink = (
    <Link
      href="/connections"
      className="inline-flex items-center gap-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary"
    >
      <svg
        className="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
      Back to Connections
    </Link>
  );

  if (loading) {
    return (
      <div>
        {backLink}
        <div className="mt-12 text-center">
          <p className="text-text-secondary">Loading connection...</p>
        </div>
      </div>
    );
  }

  if (error && !connection) {
    return (
      <div>
        {backLink}
        <div className="mt-6 rounded-lg border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div>
      {backLink}

      <div className="mt-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">
            {connection?.name || "Unnamed Connection"}
          </h1>
          <div className="mt-2 flex items-center gap-3">
            <StatusBadge status={connection?.status ?? "pending"} />
            <span className="text-xs text-text-tertiary font-mono">{id}</span>
          </div>
        </div>
        <button
          onClick={handleDelete}
          className="shrink-0 rounded-lg border border-status-error-border px-3 py-1.5 text-xs font-medium text-status-error-text transition-colors hover:bg-status-error-bg"
        >
          Delete
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          {error}
        </div>
      )}

      {/* QR Code section */}
      {(connection?.status === "scan_qr" ||
        connection?.status === "pending") && (
        <div className="mt-8 rounded-xl border border-border-secondary bg-bg-secondary p-6">
          <h2 className="text-base font-semibold text-text-primary">
            Scan QR Code
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            Open WhatsApp on your phone and scan this QR code to connect.
          </p>

          <div className="mt-6">
            {qrError && (
              <div className="rounded-lg border border-status-warning-border bg-status-warning-bg p-4 text-sm text-status-warning-text">
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
                  className="h-64 w-64 rounded-lg"
                />
              </div>
            )}

            {!qr && !qrError && (
              <div className="mx-auto flex h-64 w-64 items-center justify-center rounded-lg border border-border-primary bg-bg-elevated">
                <p className="text-sm text-text-tertiary">
                  Loading QR code...
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Connected section */}
      {connection?.status === "working" && (
        <div className="mt-8 space-y-4">
          <div className="rounded-xl border border-status-success-border bg-status-success-bg p-6">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-base font-semibold text-status-success-text">
                  Connected
                </h2>
                {profile && (
                  <p className="mt-1 text-sm text-status-success-text opacity-80">
                    {profile.id.replace("@c.us", "")}
                    {profile.pushName && ` · ${profile.pushName}`}
                  </p>
                )}
                {!profile && connection.me?.id && (
                  <p className="mt-1 text-sm text-status-success-text opacity-80">
                    {connection.me.id.replace("@c.us", "")}
                    {connection.me.pushName && ` · ${connection.me.pushName}`}
                  </p>
                )}
              </div>
              <button
                onClick={handleRestart}
                disabled={restarting}
                className="shrink-0 rounded-lg border border-status-success-border bg-bg-primary px-3 py-1.5 text-xs font-medium text-status-success-text transition-colors hover:bg-bg-hover disabled:opacity-50"
              >
                {restarting ? "Restarting..." : "Restart"}
              </button>
            </div>
          </div>

          {/* Recent chats */}
          {chats.length > 0 && (
            <div className="rounded-xl border border-border-secondary bg-bg-secondary p-6">
              <h2 className="text-base font-semibold text-text-primary">
                Recent Chats
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                Your recent WhatsApp conversations.
              </p>
              <div className="mt-4 max-h-80 space-y-1.5 overflow-y-auto">
                {chats.map((chat) => (
                  <div
                    key={chat.id}
                    className="flex items-center justify-between rounded-lg border border-border-primary bg-bg-elevated px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">
                        {chat.name ||
                          chat.id
                            .replace("@c.us", "")
                            .replace("@g.us", "")}
                      </p>
                      {chat.lastMessage && (
                        <p className="mt-0.5 truncate text-xs text-text-tertiary">
                          {chat.lastMessage.fromMe ? "You: " : ""}
                          {chat.lastMessage.body}
                        </p>
                      )}
                    </div>
                    {chat.lastMessage && (
                      <span className="ml-3 shrink-0 text-xs text-text-tertiary">
                        {new Date(
                          chat.lastMessage.timestamp * 1000
                        ).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Failed section */}
      {connection?.status === "failed" && (
        <div className="mt-8 rounded-xl border border-status-error-border bg-status-error-bg p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-base font-semibold text-status-error-text">
                Connection Failed
              </h2>
              <p className="mt-1 text-sm text-status-error-text opacity-80">
                Something went wrong. Try restarting the connection.
              </p>
            </div>
            <button
              onClick={handleRestart}
              disabled={restarting}
              className="shrink-0 rounded-lg border border-status-error-border bg-bg-primary px-3 py-1.5 text-xs font-medium text-status-error-text transition-colors hover:bg-bg-hover disabled:opacity-50"
            >
              {restarting ? "Restarting..." : "Restart"}
            </button>
          </div>
        </div>
      )}

      {/* Webhooks section */}
      <WebhookList connectionId={id} />
    </div>
  );
}
