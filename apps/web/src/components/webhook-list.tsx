"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { EventLog } from "@/components/event-log";

interface WebhookConfig {
  id: string;
  sessionId: string;
  url: string;
  events: string[];
  signingSecret: string;
  active: boolean;
  createdAt: string;
}

const EVENT_TYPES = [
  "message",
  "message.any",
  "message.ack",
  "message.reaction",
  "message.revoked",
  "state.change",
  "group.join",
  "group.leave",
  "session.status",
];

export function WebhookList({ connectionId }: { connectionId: string }) {
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [formUrl, setFormUrl] = useState("");
  const [formEvents, setFormEvents] = useState<string[]>([]);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(
    new Set()
  );
  const [expandedWebhook, setExpandedWebhook] = useState<string | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const fetchWebhooks = useCallback(async () => {
    try {
      const data = await apiFetch(
        `/api/connections/${connectionId}/webhooks`
      );
      setWebhooks(data ?? []);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load webhooks"
      );
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    fetchWebhooks();
  }, [fetchWebhooks]);

  function toggleEventType(event: string) {
    setFormEvents((prev) =>
      prev.includes(event)
        ? prev.filter((e) => e !== event)
        : [...prev, event]
    );
  }

  async function handleCreate() {
    if (!formUrl.trim()) {
      setFormError("URL is required.");
      return;
    }
    if (formEvents.length === 0) {
      setFormError("Select at least one event type.");
      return;
    }

    setFormSubmitting(true);
    setFormError(null);

    try {
      await apiFetch(`/api/connections/${connectionId}/webhooks`, {
        method: "POST",
        body: JSON.stringify({ url: formUrl.trim(), events: formEvents }),
      });
      setFormUrl("");
      setFormEvents([]);
      setShowForm(false);
      await fetchWebhooks();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create webhook"
      );
    } finally {
      setFormSubmitting(false);
    }
  }

  async function handleToggleActive(webhook: WebhookConfig) {
    setTogglingIds((prev) => new Set(prev).add(webhook.id));
    try {
      await apiFetch(`/api/webhooks/${webhook.id}`, {
        method: "PUT",
        body: JSON.stringify({ active: !webhook.active }),
      });
      await fetchWebhooks();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update webhook"
      );
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(webhook.id);
        return next;
      });
    }
  }

  async function handleDelete(webhookId: string) {
    const confirmed = window.confirm(
      "Are you sure you want to delete this webhook? This action cannot be undone."
    );
    if (!confirmed) return;

    setDeletingIds((prev) => new Set(prev).add(webhookId));
    try {
      await apiFetch(`/api/webhooks/${webhookId}`, { method: "DELETE" });
      if (expandedWebhook === webhookId) {
        setExpandedWebhook(null);
      }
      await fetchWebhooks();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to delete webhook"
      );
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(webhookId);
        return next;
      });
    }
  }

  function toggleSecretReveal(webhookId: string) {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(webhookId)) {
        next.delete(webhookId);
      } else {
        next.add(webhookId);
      }
      return next;
    });
  }

  function toggleExpand(webhookId: string) {
    setExpandedWebhook((prev) => (prev === webhookId ? null : webhookId));
  }

  return (
    <div className="mt-8 border-t border-border-primary pt-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-text-primary">
            Webhooks
          </h2>
          <p className="mt-0.5 text-sm text-text-secondary">
            Receive WhatsApp events at your endpoints.
          </p>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors hover:bg-wa-green-dark"
          >
            Add Webhook
          </button>
        )}
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-status-error-border bg-status-error-bg p-3 text-sm text-status-error-text">
          {error}
        </div>
      )}

      {/* Add Webhook Form */}
      {showForm && (
        <div className="mt-4 rounded-xl border border-border-secondary bg-bg-secondary p-5">
          <h3 className="text-sm font-semibold text-text-primary">
            New Webhook
          </h3>

          <div className="mt-4">
            <label
              htmlFor="webhook-url"
              className="mb-1.5 block text-sm font-medium text-text-secondary"
            >
              Endpoint URL
            </label>
            <input
              id="webhook-url"
              type="url"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
              placeholder="https://example.com/webhook"
              className="block w-full rounded-lg border border-border-secondary bg-bg-elevated px-3.5 py-2.5 text-sm text-text-primary transition-colors placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green"
            />
          </div>

          <div className="mt-4">
            <span className="mb-2 block text-sm font-medium text-text-secondary">
              Events
            </span>
            <div className="flex flex-wrap gap-2">
              {EVENT_TYPES.map((event) => (
                <label
                  key={event}
                  className={`inline-flex cursor-pointer items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    formEvents.includes(event)
                      ? "border-wa-green bg-wa-green text-text-inverse"
                      : "border-border-secondary bg-bg-elevated text-text-secondary hover:bg-bg-hover"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={formEvents.includes(event)}
                    onChange={() => toggleEventType(event)}
                    className="sr-only"
                  />
                  {event}
                </label>
              ))}
            </div>
          </div>

          {formError && (
            <p className="mt-3 text-sm text-status-error-text">{formError}</p>
          )}

          <div className="mt-5 flex gap-2">
            <button
              onClick={handleCreate}
              disabled={formSubmitting}
              className="rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors hover:bg-wa-green-dark disabled:opacity-50"
            >
              {formSubmitting ? "Saving..." : "Save Webhook"}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setFormUrl("");
                setFormEvents([]);
                setFormError(null);
              }}
              className="rounded-lg border border-border-secondary px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <p className="mt-4 text-sm text-text-tertiary">Loading webhooks...</p>
      )}

      {/* Empty state */}
      {!loading && !error && webhooks.length === 0 && !showForm && (
        <p className="mt-4 text-sm text-text-secondary">
          No webhooks configured. Add one to start receiving events.
        </p>
      )}

      {/* Webhook cards */}
      {webhooks.length > 0 && (
        <div className="mt-4 space-y-3">
          {webhooks.map((webhook) => (
            <div
              key={webhook.id}
              className="rounded-xl border border-border-primary bg-bg-secondary p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <button
                    onClick={() => toggleExpand(webhook.id)}
                    className="break-all text-left text-sm font-medium text-wa-green hover:underline"
                  >
                    {webhook.url}
                  </button>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {webhook.events.map((event) => (
                      <span
                        key={event}
                        className="inline-flex items-center rounded-full bg-bg-elevated px-2 py-0.5 text-xs font-medium text-text-secondary"
                      >
                        {event}
                      </span>
                    ))}
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-xs text-text-tertiary">Secret:</span>
                    <code className="text-xs text-text-secondary">
                      {revealedSecrets.has(webhook.id)
                        ? webhook.signingSecret
                        : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}
                    </code>
                    <button
                      onClick={() => toggleSecretReveal(webhook.id)}
                      className="text-xs text-text-tertiary underline hover:text-wa-green"
                    >
                      {revealedSecrets.has(webhook.id) ? "Hide" : "Reveal"}
                    </button>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => handleToggleActive(webhook)}
                    disabled={togglingIds.has(webhook.id)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-wa-green focus:ring-offset-2 focus:ring-offset-bg-primary disabled:opacity-50 ${
                      webhook.active ? "bg-wa-green" : "bg-bg-hover"
                    }`}
                    title={webhook.active ? "Active" : "Inactive"}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        webhook.active ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>

                  <button
                    onClick={() => handleDelete(webhook.id)}
                    disabled={deletingIds.has(webhook.id)}
                    className="rounded-lg border border-status-error-border px-3 py-1.5 text-xs font-medium text-status-error-text transition-colors hover:bg-status-error-bg disabled:opacity-50"
                  >
                    {deletingIds.has(webhook.id) ? "..." : "Delete"}
                  </button>
                </div>
              </div>

              <EventLog
                webhookId={webhook.id}
                expanded={expandedWebhook === webhook.id}
              />

              {expandedWebhook !== webhook.id && (
                <button
                  onClick={() => toggleExpand(webhook.id)}
                  className="mt-2 text-xs text-text-tertiary hover:text-text-secondary"
                >
                  View event log
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
