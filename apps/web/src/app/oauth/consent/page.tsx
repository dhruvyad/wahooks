"use client";

import { Suspense, useEffect, useState, startTransition } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";

interface AuthorizationDetails {
  authorization_id: string;
  redirect_uri: string;
  client: {
    id: string;
    name: string;
    uri?: string;
    logo_uri?: string;
  };
  user: {
    id: string;
    email: string;
  };
  scope: string;
}

function ConsentContent() {
  const searchParams = useSearchParams();
  const authorizationId = searchParams.get("authorization_id");
  const [details, setDetails] = useState<AuthorizationDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!authorizationId) {
      startTransition(() => {
        setError("Missing authorization_id");
        setLoading(false);
      });
      return;
    }

    const supabase = createClient();
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        // Not logged in — redirect to login, then back here
        const currentUrl = window.location.href;
        window.location.href = `/login?redirect=${encodeURIComponent(currentUrl)}`;
        return;
      }

      try {
        const resp = await fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/oauth/authorizations/${authorizationId}`,
          {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
              apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
            },
          }
        );

        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          setError(data.error_description || data.message || "Failed to load authorization details");
          setLoading(false);
          return;
        }

        const data = await resp.json();
        setDetails(data);
        setLoading(false);
      } catch (e) {
        setError("Failed to load authorization details");
        setLoading(false);
      }
    });
  }, [authorizationId]);

  async function handleConsent(action: "approve" | "deny") {
    if (!authorizationId) return;
    setSubmitting(true);

    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setError("Session expired");
      return;
    }

    try {
      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/oauth/authorizations/${authorizationId}/consent`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action }),
        }
      );

      const data = await resp.json();

      if (data.redirect_url) {
        window.location.href = data.redirect_url;
      } else {
        setError("No redirect URL returned");
        setSubmitting(false);
      }
    } catch (e) {
      setError("Failed to submit consent");
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-8 text-center">
        <p className="text-text-secondary">Loading authorization details...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-8 text-center">
        <h2 className="text-lg font-semibold text-status-error-text">
          Authorization Error
        </h2>
        <p className="mt-2 text-sm text-text-tertiary">{error}</p>
        <Link
          href="/"
          className="mt-4 inline-block text-sm text-wa-green hover:underline"
        >
          Go to homepage
        </Link>
      </div>
    );
  }

  if (!details) return null;

  return (
    <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-8">
      <div className="mb-6 text-center">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-2xl font-bold tracking-tight text-wa-green"
        >
          <img src="/logo.svg" alt="" className="h-8 w-8" />
          WAHooks
        </Link>
        <p className="mt-2 text-sm text-text-tertiary">
          Authorize application access
        </p>
      </div>

      <div className="rounded-lg border border-border-secondary bg-bg-elevated p-4 mb-4">
        <p className="text-sm text-text-secondary">
          <span className="font-medium text-text-primary">
            {details.client.name || "An application"}
          </span>
          {" "}wants to access your WAHooks account.
        </p>
      </div>

      <div className="rounded-lg border border-border-secondary bg-bg-elevated p-4 mb-4">
        <p className="text-xs text-text-tertiary mb-1">Signed in as</p>
        <p className="text-sm font-medium text-text-primary">
          {details.user.email}
        </p>
      </div>

      {details.scope && (
        <div className="rounded-lg border border-border-secondary bg-bg-elevated p-4 mb-4">
          <p className="text-xs text-text-tertiary mb-2">Requested permissions</p>
          <div className="flex flex-wrap gap-1.5">
            {details.scope.split(" ").map((scope) => (
              <span
                key={scope}
                className="rounded-full bg-wa-green-muted px-2.5 py-0.5 text-xs font-medium text-wa-green"
              >
                {scope}
              </span>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-text-tertiary mb-4">
        This will allow the application to manage your WhatsApp connections,
        send messages, and configure webhooks on your behalf.
      </p>

      <div className="flex gap-3">
        <button
          onClick={() => handleConsent("deny")}
          disabled={submitting}
          className="flex-1 rounded-lg border border-border-secondary px-4 py-2.5 text-sm font-medium text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-50"
        >
          Deny
        </button>
        <button
          onClick={() => handleConsent("approve")}
          disabled={submitting}
          className="flex-1 rounded-lg bg-wa-green px-4 py-2.5 text-sm font-semibold text-text-inverse hover:bg-wa-green-dark transition-colors disabled:opacity-50"
        >
          {submitting ? "Authorizing..." : "Allow"}
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
