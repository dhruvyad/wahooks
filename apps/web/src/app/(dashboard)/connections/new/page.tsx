"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "@/lib/api";

export default function NewConnectionPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const connection = await apiFetch("/api/connections", {
        method: "POST",
        body: JSON.stringify({ name: name || undefined }),
      });
      router.push(`/connections/${connection.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create connection");
      setLoading(false);
    }
  }

  return (
    <div>
      <Link
        href="/connections"
        className="text-sm text-text-secondary hover:text-wa-green"
      >
        &larr; Back to Connections
      </Link>

      <h1 className="mt-4 text-2xl font-bold text-text-primary">New Connection</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Create a new WhatsApp connection.
      </p>

      {error && (
        <div className="mt-4 rounded-md border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-8 max-w-md space-y-6">
        <div>
          <label
            htmlFor="name"
            className="block text-sm font-medium text-text-secondary"
          >
            Name (optional)
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My Business WhatsApp"
            disabled={loading}
            className="mt-1 block w-full rounded-md border border-border-secondary bg-bg-elevated px-3 py-2 text-text-primary shadow-sm placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green disabled:opacity-50"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-wa-green px-4 py-2 text-sm font-medium text-text-inverse hover:bg-wa-green-dark disabled:opacity-50 transition-colors"
        >
          {loading ? "Creating..." : "Create Connection"}
        </button>
      </form>
    </div>
  );
}
