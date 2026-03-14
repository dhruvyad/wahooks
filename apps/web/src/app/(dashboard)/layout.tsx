"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { SignOutButton } from "./sign-out-button";
import { NavLinks } from "./nav-links";
import { ToastProvider } from "@/components/toast";
import { ConfirmModalProvider } from "@/components/confirm-modal";
import { AuthListener } from "@/components/auth-listener";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.email) {
        setEmail(session.user.email);
      }
    });
  }, []);

  return (
    <ToastProvider>
      <ConfirmModalProvider>
        <div className="flex h-screen overflow-hidden">
          <aside className="flex w-64 flex-col border-r border-border-primary bg-bg-secondary">
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
                {email ?? "\u00A0"}
              </p>
              <SignOutButton />
            </div>
          </aside>
          <main className="flex-1 overflow-y-auto bg-bg-primary p-8">
            <AuthListener />
            {children}
          </main>
        </div>
      </ConfirmModalProvider>
    </ToastProvider>
  );
}
