"use client";

import { useState } from "react";
import Link from "next/link";

export default function NewConnectionPage() {
  const [name, setName] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // TODO: Call API to create connection
    // const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
    // await fetch(`${API_URL}/connections`, { method: "POST", body: ... });
    alert(`Connection creation is not yet implemented. Name: ${name || "(unnamed)"}`);
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
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
          />
        </div>

        <button
          type="submit"
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
        >
          Create Connection
        </button>
      </form>
    </div>
  );
}
