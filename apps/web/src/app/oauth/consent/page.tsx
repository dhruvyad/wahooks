"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";

function ConsentContent() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Supabase passes these params for the consent flow
  const clientName = searchParams.get("client_name") || "MCP Client";

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setEmail(session.user.email ?? session.user.id);
        setLoading(false);
      } else {
        // Not logged in — redirect to login, then back here
        const currentUrl = window.location.href;
        window.location.href = `/login?redirect=${encodeURIComponent(currentUrl)}`;
      }
    });
  }, []);

  function handleAllow() {
    // Submit the consent form back to Supabase
    // The consent page needs to POST/redirect back with approval
    // Supabase expects us to redirect back to the authorization endpoint with consent=true
    const params = new URLSearchParams(window.location.search);
    params.set("consent", "true");
    window.location.href = `https://fvatjlbtyegsqjuwbxxx.supabase.co/auth/v1/oauth/authorize?${params.toString()}`;
  }

  function handleDeny() {
    // Redirect back with denial
    const redirectUri = searchParams.get("redirect_uri");
    if (redirectUri) {
      window.location.href = `${redirectUri}?error=access_denied&error_description=User+denied+the+request`;
    } else {
      window.location.href = "/";
    }
  }

  if (loading) {
    return (
      <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-8 text-center">
        <p className="text-text-secondary">Checking authentication...</p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-8">
      <div className="mb-6 text-center">
        <Link
          href="/"
          className="text-2xl font-bold tracking-tight text-wa-green"
        >
          WAHooks
        </Link>
        <p className="mt-2 text-sm text-text-tertiary">
          Authorize application access
        </p>
      </div>

      <div className="rounded-lg border border-border-secondary bg-bg-elevated p-4 mb-4">
        <p className="text-sm text-text-secondary">
          <span className="font-medium text-text-primary">{clientName}</span>
          {" "}wants to access your WAHooks account.
        </p>
      </div>

      <div className="rounded-lg border border-border-secondary bg-bg-elevated p-4 mb-6">
        <p className="text-xs text-text-tertiary mb-2">Signed in as</p>
        <p className="text-sm font-medium text-text-primary">{email}</p>
      </div>

      <p className="text-xs text-text-tertiary mb-4">
        This will allow the application to manage your WhatsApp connections,
        send messages, and configure webhooks on your behalf.
      </p>

      <div className="flex gap-3">
        <button
          onClick={handleDeny}
          className="flex-1 rounded-lg border border-border-secondary px-4 py-2.5 text-sm font-medium text-text-secondary hover:bg-bg-hover transition-colors"
        >
          Deny
        </button>
        <button
          onClick={handleAllow}
          className="flex-1 rounded-lg bg-wa-green px-4 py-2.5 text-sm font-semibold text-text-inverse hover:bg-wa-green-dark transition-colors"
        >
          Allow
        </button>
      </div>
    </div>
  );
}

export default function ConsentPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary">
      <Suspense
        fallback={
          <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-8 text-center">
            <p className="text-text-secondary">Loading...</p>
          </div>
        }
      >
        <ConsentContent />
      </Suspense>
    </div>
  );
}
