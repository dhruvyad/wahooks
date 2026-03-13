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
      setError(
        err instanceof Error ? err.message : "Failed to create connection"
      );
      setLoading(false);
    }
  }

  return (
    <div>
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
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 19l-7-7 7-7"
          />
        </svg>
        Back to Connections
      </Link>

      <div className="mt-6">
        <h1 className="text-2xl font-bold text-text-primary">New Connection</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Create a new managed WhatsApp connection.
        </p>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          {error}
        </div>
      )}

      <div className="mt-8 max-w-lg rounded-xl border border-border-primary bg-bg-secondary p-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label
              htmlFor="name"
              className="mb-1.5 block text-sm font-medium text-text-secondary"
            >
              Name{" "}
              <span className="font-normal text-text-tertiary">(optional)</span>
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My Business WhatsApp"
              disabled={loading}
              className="block w-full rounded-lg border border-border-secondary bg-bg-elevated px-3.5 py-2.5 text-text-primary transition-colors placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green disabled:opacity-50"
            />
            <p className="mt-1.5 text-xs text-text-tertiary">
              A friendly name to identify this connection.
            </p>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-wa-green px-4 py-2.5 text-sm font-semibold text-text-inverse transition-colors hover:bg-wa-green-dark disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create Connection"}
          </button>
        </form>
      </div>
    </div>
  );
}
