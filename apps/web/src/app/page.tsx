import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-4xl font-bold">WAHooks</h1>
      <p className="mt-4 text-lg text-gray-600">
        Cloud-hosted WhatsApp webhooks
      </p>
      <div className="mt-8 flex gap-4">
        <Link
          href="/login"
          className="rounded-md bg-black px-6 py-2.5 text-sm font-medium text-white hover:bg-gray-800"
        >
          Sign in
        </Link>
        <Link
          href="/signup"
          className="rounded-md border border-gray-300 px-6 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Sign up
        </Link>
      </div>
    </main>
  );
}
