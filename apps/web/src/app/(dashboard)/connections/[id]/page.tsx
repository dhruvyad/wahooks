import Link from "next/link";

// TODO: Fetch connection details from API once it's ready
// const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
// const res = await fetch(`${API_URL}/connections/${params.id}`, { ... });

export default async function ConnectionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div>
      <Link
        href="/connections"
        className="text-sm text-gray-500 hover:text-black"
      >
        &larr; Back to Connections
      </Link>

      <div className="mt-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Connection {id}</h1>
        {/* TODO: Wire up delete to API */}
        <button className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50">
          Delete
        </button>
      </div>

      {/* TODO: Replace with real status from API */}
      <div className="mt-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-700">Status:</span>
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">
            Unknown
          </span>
        </div>

        <div>
          <span className="text-sm font-medium text-gray-700">ID:</span>
          <span className="ml-2 text-sm text-gray-500">{id}</span>
        </div>
      </div>

      {/* TODO: Add webhook configuration section */}
      {/* TODO: Add session QR code / auth section */}
      {/* TODO: Add event log section */}
    </div>
  );
}
