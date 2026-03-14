"use client";

import { useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { CopyButton } from "@/components/copy-button";
import { TokenListSkeleton } from "@/components/skeletons";

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

interface CreatedToken {
  id: string;
  name: string;
  prefix: string;
  token: string;
}

export default function TokensPage() {
  const { toast } = useToast();
  const { confirm } = useConfirm();

  const {
    data: tokens,
    loading,
    error,
    mutate,
  } = useApiData<ApiToken[]>("tokens", () => apiFetch("/api/tokens"));

  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formSubmitting, setFormSubmitting] = useState(false);

  const [newlyCreated, setNewlyCreated] = useState<CreatedToken | null>(null);

  const list = tokens ?? [];

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim()) return;

    setFormSubmitting(true);

    // Optimistic: add a placeholder
    const tempId = "temp-" + Math.random().toString(36).slice(2, 9);
    const optimisticToken: ApiToken = {
      id: tempId,
      name: formName.trim(),
      prefix: "wah_...",
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
    };
    mutate((prev) => (prev ? [optimisticToken, ...prev] : [optimisticToken]));

    try {
      const created = await apiFetch("/api/tokens", {
        method: "POST",
        body: JSON.stringify({ name: formName.trim() }),
      });
      // Replace optimistic entry with real one
      mutate((prev) =>
        prev
          ? prev.map((t) =>
              t.id === tempId
                ? {
                    id: created.id,
                    name: created.name,
                    prefix: created.prefix,
                    lastUsedAt: null,
                    createdAt: created.createdAt ?? new Date().toISOString(),
                  }
                : t
            )
          : prev
      );
      setNewlyCreated(created);
      setFormName("");
      setShowForm(false);
      toast("API token created", "success");
    } catch (err) {
      // Rollback
      mutate((prev) => (prev ? prev.filter((t) => t.id !== tempId) : prev));
      toast(
        err instanceof Error ? err.message : "Failed to create token",
        "error"
      );
    } finally {
      setFormSubmitting(false);
    }
  }

  async function handleRevoke(tokenId: string) {
    const confirmed = await confirm({
      title: "Revoke token",
      message:
        "Are you sure you want to revoke this token? This action cannot be undone.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!confirmed) return;

    // Optimistic remove
    const prev = list;
    mutate(list.filter((tok) => tok.id !== tokenId));

    try {
      await apiFetch(`/api/tokens/${tokenId}`, { method: "DELETE" });
      toast("Token revoked", "success");
    } catch (err) {
      // Rollback
      mutate(prev);
      toast(
        err instanceof Error ? err.message : "Failed to revoke token",
        "error"
      );
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary">API Tokens</h1>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors duration-150 hover:bg-wa-green-dark"
          >
            Create Token
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-text-secondary">
        Manage API tokens for programmatic access.
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Link
          href="/docs/sdk/typescript"
          className="inline-flex items-center gap-1.5 rounded-md border border-border-primary px-2.5 py-1 text-xs text-text-tertiary transition-colors duration-150 hover:border-border-secondary hover:text-text-secondary"
        >
          TypeScript SDK Quickstart
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25" /></svg>
        </Link>
        <Link
          href="/docs/sdk/python"
          className="inline-flex items-center gap-1.5 rounded-md border border-border-primary px-2.5 py-1 text-xs text-text-tertiary transition-colors duration-150 hover:border-border-secondary hover:text-text-secondary"
        >
          Python SDK Quickstart
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25" /></svg>
        </Link>
        <Link
          href="/docs/cli/installation"
          className="inline-flex items-center gap-1.5 rounded-md border border-border-primary px-2.5 py-1 text-xs text-text-tertiary transition-colors duration-150 hover:border-border-secondary hover:text-text-secondary"
        >
          CLI Quickstart
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25" /></svg>
        </Link>
      </div>

      {/* Newly created token warning */}
      {newlyCreated && (
        <div className="mt-4 rounded-xl border border-status-warning-border bg-status-warning-bg p-4">
          <p className="text-sm font-semibold text-status-warning-text">
            Save your token now — it will not be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all rounded-lg bg-bg-elevated px-3 py-2 text-sm text-text-primary font-mono">
              {newlyCreated.token}
            </code>
            <CopyButton text={newlyCreated.token} />
          </div>
          <button
            onClick={() => setNewlyCreated(null)}
            className="mt-3 text-xs text-status-warning-text underline hover:no-underline"
          >
            I have saved my token
          </button>
        </div>
      )}

      {/* Inline create form */}
      {showForm && (
        <div className="mt-4 rounded-xl border border-border-secondary bg-bg-secondary p-5">
          <h3 className="text-sm font-semibold text-text-primary">
            New API Token
          </h3>
          <form onSubmit={handleCreate} className="mt-3 flex items-end gap-3">
            <div className="flex-1">
              <label
                htmlFor="token-name"
                className="mb-1.5 block text-sm font-medium text-text-secondary"
              >
                Token Name
              </label>
              <input
                id="token-name"
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. CI/CD Pipeline"
                disabled={formSubmitting}
                className="block w-full rounded-lg border border-border-secondary bg-bg-elevated px-3.5 py-2.5 text-sm text-text-primary transition-colors duration-150 placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green disabled:opacity-50"
              />
            </div>
            <button
              type="submit"
              disabled={formSubmitting || !formName.trim()}
              className="rounded-lg bg-wa-green px-4 py-2.5 text-sm font-semibold text-text-inverse transition-colors duration-150 hover:bg-wa-green-dark disabled:opacity-50"
            >
              {formSubmitting ? "Creating..." : "Create"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setFormName("");
              }}
              className="rounded-lg border border-border-secondary px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover"
            >
              Cancel
            </button>
          </form>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          {error}
        </div>
      )}

      {loading && <TokenListSkeleton />}

      {!loading && !error && list.length === 0 && (
        <div className="mt-16 flex flex-col items-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border-primary bg-bg-secondary">
            <span className="text-3xl">🔑</span>
          </div>
          <p className="mt-4 text-base font-medium text-text-primary">
            No API tokens yet
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            Create a token to access the WAHooks API programmatically.
          </p>
        </div>
      )}

      {list.length > 0 && (
        <div className="mt-6 space-y-2">
          {list.map((token) => (
            <div
              key={token.id}
              className="flex items-center justify-between rounded-xl border border-border-primary bg-bg-secondary px-5 py-4 transition-colors duration-150 hover:border-border-secondary"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text-primary">
                  {token.name}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-tertiary">
                  <span className="font-mono">{token.prefix}...</span>
                  <span>
                    Created {formatDate(token.createdAt)}
                  </span>
                  <span>
                    {token.lastUsedAt
                      ? `Last used ${formatDate(token.lastUsedAt)}`
                      : "Never used"}
                  </span>
                </div>
              </div>
              <button
                onClick={() => handleRevoke(token.id)}
                className="shrink-0 rounded-lg border border-status-error-border px-3 py-1.5 text-xs font-medium text-status-error-text transition-colors duration-150 hover:bg-status-error-bg"
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
