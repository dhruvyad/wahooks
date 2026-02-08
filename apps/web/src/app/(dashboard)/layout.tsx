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
      <aside className="w-64 border-r border-border-primary bg-bg-secondary p-6">
        <div className="mb-8">
          <Link href="/connections" className="text-xl font-bold text-wa-green">
            WAHooks
          </Link>
        </div>
        <nav className="space-y-2">
          <Link
            href="/connections"
            className="block rounded-md px-3 py-2 text-sm font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          >
            Connections
          </Link>
          <Link
            href="/billing"
            className="block rounded-md px-3 py-2 text-sm font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          >
            Billing
          </Link>
        </nav>
        <div className="mt-auto pt-8">
          <p className="mb-2 truncate text-sm text-text-tertiary">{user.email}</p>
          <SignOutButton />
        </div>
      </aside>
      <main className="flex-1 bg-bg-primary p-8">{children}</main>
    </div>
  );
}
