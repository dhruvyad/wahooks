"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";

interface Connection {
  id: string;
  name: string | null;
  status: string;
  me: { id: string; pushName?: string } | null;
}

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/connections")
      .then((data) => {
        setConnections(data ?? []);
      })
      .catch((err) => {
        setError(err.message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Connections</h1>
        <Link
          href="/connections/new"
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
        >
          New Connection
        </Link>
      </div>

      {loading && (
        <div className="mt-12 text-center">
          <p className="text-gray-500">Loading connections...</p>
        </div>
      )}

      {error && (
        <div className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Failed to load connections: {error}
        </div>
      )}

      {!loading && !error && connections.length === 0 && (
        <div className="mt-12 text-center">
          <p className="text-gray-500">
            No connections yet. Create your first WhatsApp connection.
          </p>
          <Link
            href="/connections/new"
            className="mt-4 inline-block text-sm font-medium text-black underline hover:no-underline"
          >
            Create a connection
          </Link>
        </div>
      )}

      {!loading && !error && connections.length > 0 && (
        <div className="mt-6 space-y-3">
          {connections.map((conn) => (
            <Link
              key={conn.id}
              href={`/connections/${conn.id}`}
              className="flex items-center justify-between rounded-md border border-gray-200 px-4 py-3 hover:bg-gray-50"
            >
              <div className="flex items-center gap-3">
                <span className="font-medium">
                  {conn.name || "Unnamed Connection"}
                </span>
                <StatusBadge status={conn.status} />
              </div>
              <span className="text-sm text-gray-500">
                {conn.me?.id
                  ? conn.me.id.replace("@c.us", "")
                  : "No phone linked"}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
