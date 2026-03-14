"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

export function MobileSidebarToggle() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close sidebar on navigation
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      {/* Hamburger button — only visible on mobile */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="fixed left-4 top-4 z-50 rounded-lg border border-border-primary bg-bg-secondary p-2 text-text-secondary shadow-lg md:hidden"
        aria-label="Menu"
      >
        {open ? (
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        )}
      </button>

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Sidebar overlay class — applied via CSS */}
      <style>{`
        @media (max-width: 767px) {
          [data-sidebar] {
            position: fixed;
            z-index: 40;
            transform: translateX(${open ? "0" : "-100%"});
            transition: transform 200ms ease;
          }
          [data-main] {
            margin-left: 0 !important;
            padding-top: 3.5rem;
          }
        }
      `}</style>
    </>
  );
}
