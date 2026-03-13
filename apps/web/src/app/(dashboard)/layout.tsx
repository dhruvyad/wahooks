import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { SignOutButton } from "./sign-out-button";
import { NavLinks } from "./nav-links";

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
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-64 flex-col border-r border-border-primary bg-bg-secondary">
        <div className="border-b border-border-primary px-6 py-5">
          <Link
            href="/connections"
            className="text-xl font-bold tracking-tight text-wa-green"
          >
            WAHooks
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <NavLinks />
        </div>
        <div className="border-t border-border-primary px-4 py-4">
          <p className="mb-3 truncate text-xs text-text-tertiary">
            {user.email}
          </p>
          <SignOutButton />
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto bg-bg-primary p-8">
        {children}
      </main>
    </div>
  );
}
