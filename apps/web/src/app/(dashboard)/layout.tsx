import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { SignOutButton } from "./sign-out-button";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 border-r border-gray-200 bg-gray-50 p-6">
        <div className="mb-8">
          <Link href="/connections" className="text-xl font-bold">
            WAHooks
          </Link>
        </div>
        <nav className="space-y-2">
          <Link
            href="/connections"
            className="block rounded-md px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
          >
            Connections
          </Link>
          <Link
            href="/billing"
            className="block rounded-md px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
          >
            Billing
          </Link>
        </nav>
        <div className="mt-auto pt-8">
          <p className="mb-2 truncate text-sm text-gray-500">{user.email}</p>
          <SignOutButton />
        </div>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
