"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { NavLinks } from "@/app/(dashboard)/nav-links";
import { SignOutButton } from "@/app/(dashboard)/sign-out-button";

export function MobileSidebar({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close on navigation
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Prevent body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      {/* Hamburger — mobile only, hidden when sidebar is open */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed left-4 top-4 z-50 rounded-lg border border-border-primary bg-bg-secondary p-2 text-text-secondary shadow-lg md:hidden"
          aria-label="Open menu"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      )}

      {/* Overlay */}
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
          />

          {/* Sidebar panel */}
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border-primary bg-bg-secondary shadow-xl">
            <div className="flex items-center justify-between border-b border-border-primary px-5 py-4">
              <Link href="/connections" className="flex items-center gap-2">
                <img src="/logo.svg" alt="" className="h-6 w-6" />
                <span className="text-lg font-bold text-wa-green">WAHooks</span>
              </Link>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-text-tertiary hover:text-text-primary"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-4">
              <NavLinks />
            </div>
            <div className="border-t border-border-primary px-4 py-4">
              <p className="mb-3 truncate text-xs text-text-tertiary">{email}</p>
              <SignOutButton />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
