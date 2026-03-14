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
              <a
                href="https://discord.gg/B2XNf97Vby"
                target="_blank"
                rel="noopener noreferrer"
                className="mb-3 flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
              >
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 127.14 96.36"><path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0 105.89 105.89 0 0 0 19.39 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2.03a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2.03a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53.05s5-12.68 11.45-12.68S54 46.05 53.89 53.05s-5.05 12.64-11.44 12.64Zm42.24 0C78.41 65.69 73.25 60 73.25 53.05s5-12.68 11.44-12.68S96.23 46.05 96.12 53.05s-5 12.64-11.43 12.64Z"/></svg>
                Community
              </a>
              <p className="mb-3 truncate text-xs text-text-tertiary px-3">{email}</p>
              <SignOutButton />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
