import Link from "next/link";

// TODO: Fetch connections from API once it's ready
// const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
// const res = await fetch(`${API_URL}/connections`, { ... });

export default function ConnectionsPage() {
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

      {/* TODO: Replace with real connection list from API */}
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
    </div>
  );
}
