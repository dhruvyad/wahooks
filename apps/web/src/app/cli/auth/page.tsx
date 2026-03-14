"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";

function CLIAuthContent() {
  const searchParams = useSearchParams();
  const port = searchParams.get("port");
  const initialStatus = port ? "loading" : "no-port";
  const [status, setStatus] = useState<
    "loading" | "ready" | "done" | "error" | "no-port"
  >(initialStatus);
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!port) return;

    const supabase = createClient();
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setEmail(session.user.email ?? session.user.id);
        setStatus("ready");
      } else {
        window.location.href = `/login?redirect=/cli/auth?port=${port}`;
      }
    });
  }, [port]);

  async function handleAuthorize() {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      setStatus("error");
      return;
    }

    try {
      const callbackUrl = `http://localhost:${port}/callback`;
      const resp = await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
        }),
      });

      if (resp.ok) {
        setStatus("done");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  if (status === "no-port") {
    return (
      <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-8 text-center">
        <p className="text-text-secondary">
          This page is used by the WAHooks CLI.
        </p>
        <p className="mt-2 text-sm text-text-tertiary">
          Run{" "}
          <code className="rounded bg-bg-elevated px-1.5 py-0.5 font-mono text-xs">
            wahooks login
          </code>{" "}
          in your terminal.
        </p>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-8 text-center">
        <p className="text-text-secondary">Checking authentication...</p>
      </div>
    );
  }

  if (status === "done") {
    return (
      <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-8 text-center">
        <div className="mb-4 text-4xl">&#10003;</div>
        <h2 className="text-lg font-semibold text-text-primary">
          CLI Authorized
        </h2>
        <p className="mt-2 text-sm text-text-tertiary">
          You can close this tab and return to your terminal.
        </p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-8 text-center">
        <h2 className="text-lg font-semibold text-status-error-text">
          Authorization failed
        </h2>
        <p className="mt-2 text-sm text-text-tertiary">
          Make sure the CLI is still running and try again.
        </p>
        <button
          onClick={handleAuthorize}
          className="mt-4 rounded-lg bg-wa-green px-6 py-2.5 text-sm font-semibold text-text-inverse transition-colors hover:bg-wa-green-dark"
        >
          Retry
        </button>
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
          Authorize the CLI to access your account
        </p>
      </div>

      <div className="rounded-lg border border-border-secondary bg-bg-elevated p-4">
        <p className="text-sm text-text-secondary">
          Signed in as{" "}
          <span className="font-medium text-text-primary">{email}</span>
        </p>
      </div>

      <button
        onClick={handleAuthorize}
        className="mt-6 w-full rounded-lg bg-wa-green px-4 py-2.5 text-sm font-semibold text-text-inverse transition-colors hover:bg-wa-green-dark"
      >
        Authorize CLI
      </button>

      <p className="mt-4 text-center text-xs text-text-tertiary">
        This will grant the CLI access to your WAHooks account.
      </p>
    </div>
  );
}

export default function CLIAuthPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary">
      <Suspense
        fallback={
          <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-8 text-center">
            <p className="text-text-secondary">Loading...</p>
          </div>
        }
      >
        <CLIAuthContent />
      </Suspense>
    </div>
  );
}
