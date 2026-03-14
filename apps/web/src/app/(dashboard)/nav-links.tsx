"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { apiFetch } from "@/lib/api";

const navItems = [
  { href: "/connections", label: "Connections" },
  { href: "/tokens", label: "API Tokens" },
  { href: "/mcp", label: "MCP" },
  { href: "/infrastructure", label: "Infrastructure", adminOnly: true },
  { href: "/billing", label: "Billing" },
];

export function NavLinks() {
  const pathname = usePathname();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    apiFetch("/api/me")
      .then((data: any) => setIsAdmin(!!data?.isAdmin))
      .catch(() => {});
  }, []);

  return (
    <nav className="space-y-1">
      {navItems
        .filter((item) => !("adminOnly" in item && item.adminOnly) || isAdmin)
        .map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded-md px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                isActive
                  ? "bg-wa-green/10 text-wa-green"
                  : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
    </nav>
  );
}
