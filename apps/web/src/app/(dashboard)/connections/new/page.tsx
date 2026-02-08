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
        className="text-sm text-gray-500 hover:text-black"
      >
        &larr; Back to Connections
      </Link>

      <h1 className="mt-4 text-2xl font-bold">New Connection</h1>
      <p className="mt-1 text-sm text-gray-500">
        Create a new WhatsApp connection.
      </p>

      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-8 max-w-md space-y-6">
        <div>
          <label
            htmlFor="name"
            className="block text-sm font-medium text-gray-700"
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
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-black focus:outline-none focus:ring-1 focus:ring-black disabled:opacity-50"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {loading ? "Creating..." : "Create Connection"}
        </button>
      </form>
    </div>
  );
}
