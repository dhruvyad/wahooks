import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { SignOutButton } from "./sign-out-button";
import { NavLinks } from "./nav-links";
import { ToastProvider } from "@/components/toast";
import { ConfirmModalProvider } from "@/components/confirm-modal";
import { AuthListener } from "@/components/auth-listener";
import { MobileSidebarToggle } from "@/components/mobile-sidebar";

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
    <ToastProvider>
      <ConfirmModalProvider>
        <MobileSidebarToggle />
        <div className="flex h-screen overflow-hidden">
          <aside
            data-sidebar
            className="flex h-full w-64 shrink-0 flex-col border-r border-border-primary bg-bg-secondary max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:-translate-x-full"
          >
            <div className="border-b border-border-primary px-6 py-5">
              <Link
                href="/connections"
                className="flex items-center gap-2.5"
              >
                <img src="/logo.svg" alt="" className="h-7 w-7" />
                <span className="text-xl font-bold tracking-tight text-wa-green">WAHooks</span>
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
          <main data-main className="flex-1 overflow-y-auto bg-bg-primary p-6 md:p-8">
            <AuthListener />
            {children}
          </main>
        </div>
      </ConfirmModalProvider>
    </ToastProvider>
  );
}
