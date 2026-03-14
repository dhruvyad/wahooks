"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";
import { StatusBadge } from "@/components/status-badge";
import { WebhookList } from "@/components/webhook-list";
import { CopyButton } from "@/components/copy-button";
import { ConnectionDetailSkeleton } from "@/components/skeletons";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";

interface Connection {
  id: string;
  name: string | null;
  status: string;
  me: { id: string; pushName?: string } | null;
}

interface QrData {
  value: string;
  mimetype: string;
}

interface ChatItem {
  id: string;
  name?: string;
  timestamp: number;
  lastMessage?: { body: string; timestamp: number; fromMe: boolean };
}

interface WaProfile {
  id: string;
  pushName: string;
}

function getStoredName(connectionId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(`wahooks-conn-name-${connectionId}`);
  } catch {
    return null;
  }
}

function setStoredName(connectionId: string, name: string) {
  if (typeof window === "undefined") return;
  try {
    if (name.trim()) {
      localStorage.setItem(`wahooks-conn-name-${connectionId}`, name.trim());
    } else {
      localStorage.removeItem(`wahooks-conn-name-${connectionId}`);
    }
  } catch {
    // ignore
  }
}

export default function ConnectionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const id = params.id;

  const {
    data: connection,
    loading,
    error,
    mutate: mutateConnection,
  } = useApiData<Connection>(`connection-${id}`, () =>
    apiFetch(`/api/connections/${id}`)
  );

  const [qr, setQr] = useState<QrData | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  const [restarting, setRestarting] = useState(false);

  const [chats, setChats] = useState<ChatItem[]>([]);
  const [profile, setProfile] = useState<WaProfile | null>(null);

  // Send message state
  const [sendChatId, setSendChatId] = useState("");
  const [sendText, setSendText] = useState("");
  const [sending, setSending] = useState(false);
  const [showChatSuggestions, setShowChatSuggestions] = useState(false);
  const chatInputRef = useRef<HTMLInputElement>(null);

  // Editable name
  const [editingName, setEditingName] = useState(false);
  const [customName, setCustomName] = useState<string>("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Chat viewer
  const [selectedChat, setSelectedChat] = useState<ChatItem | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const connectionRef = useRef<Connection | null>(null);
  connectionRef.current = connection;

  // Fetch messages when a chat is selected
  useEffect(() => {
    if (!selectedChat || !id) return;
    let cancelled = false;
    setMessagesLoading(true);
    setMessages([]);

    apiFetch(`/api/connections/${id}/chats/${encodeURIComponent(selectedChat.id)}/messages`)
      .then((msgs: any) => {
        if (!cancelled && Array.isArray(msgs)) {
          // Messages come newest first, reverse for display
          setMessages(msgs.reverse());
          setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
        }
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });

    return () => { cancelled = true; };
  }, [selectedChat?.id, id]);

  // Initialize custom name from localStorage
  useEffect(() => {
    const stored = getStoredName(id);
    if (stored) {
      setCustomName(stored);
    }
  }, [id]);

  const fetchConnection = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/connections/${id}`);
      mutateConnection(data);
      return data as Connection;
    } catch {
      return null;
    }
  }, [id, mutateConnection]);

  const fetchQr = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/connections/${id}/qr`);
      if (data.connected) {
        mutateConnection((prev: Connection | null) =>
          prev ? { ...prev, status: "working" } : prev
        );
        setQr(null);
        setQrError(null);
        return;
      }
      setQr(data);
      setQrError(null);
    } catch (err) {
      setQrError(
        err instanceof Error ? err.message : "Failed to load QR code"
      );
    }
  }, [id, mutateConnection]);

  useEffect(() => {
    const interval = setInterval(() => {
      const current = connectionRef.current;
      if (
        current &&
        (current.status === "scan_qr" || current.status === "pending")
      ) {
        fetchConnection();
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [fetchConnection]);

  useEffect(() => {
    if (!connection) return;

    if (connection.status === "scan_qr" || connection.status === "pending") {
      fetchQr();

      const interval = setInterval(() => {
        fetchQr();
      }, 3000);

      return () => clearInterval(interval);
    } else {
      setQr(null);
      setQrError(null);
    }
  }, [connection?.status, fetchQr, connection]);

  useEffect(() => {
    if (connection?.status !== "working") return;

    async function fetchConnectedData() {
      const [meData, chatsData] = await Promise.all([
        apiFetch(`/api/connections/${id}/me`).catch(() => null),
        apiFetch(`/api/connections/${id}/chats`).catch(() => []),
      ]);
      if (meData) setProfile(meData);
      setChats(chatsData ?? []);
    }

    fetchConnectedData();
  }, [connection?.status, id]);

  async function handleRestart() {
    setRestarting(true);
    mutateConnection((prev: Connection | null) =>
      prev ? { ...prev, status: "scan_qr" } : prev
    );
    setChats([]);
    setProfile(null);
    setSelectedChat(null);
    try {
      await apiFetch(`/api/connections/${id}/restart`, { method: "POST" });
      await fetchConnection();
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Failed to restart connection",
        "error"
      );
    } finally {
      setRestarting(false);
    }
  }

  async function handleDelete() {
    const confirmed = await confirm({
      title: "Delete connection",
      message:
        "Are you sure you want to delete this connection? This action cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;

    // Optimistic: navigate immediately
    router.push("/connections");
    apiFetch(`/api/connections/${id}`, { method: "DELETE" })
      .then(() => {
        toast("Connection deleted", "success");
      })
      .catch(() => {
        toast("Failed to delete connection", "error");
      });
  }

  function handleNameEdit() {
    setEditingName(true);
    const displayName =
      customName ||
      connection?.name ||
      "";
    setCustomName(displayName);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }

  function handleNameSave() {
    setEditingName(false);
    setStoredName(id, customName);
  }

  function handleNameKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      handleNameSave();
    } else if (e.key === "Escape") {
      setEditingName(false);
      const stored = getStoredName(id);
      setCustomName(stored || "");
    }
  }

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!sendChatId.trim() || !sendText.trim()) return;

    const messageText = sendText.trim();
    const chatId = sendChatId.trim();
    setSending(true);

    // Optimistic: add message to chat view immediately
    if (selectedChat && selectedChat.id === chatId) {
      const optimisticMsg = {
        id: `temp-${Date.now()}`,
        fromMe: true,
        body: messageText,
        timestamp: Math.floor(Date.now() / 1000),
      };
      setMessages((prev) => [...prev, optimisticMsg]);
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }

    try {
      await apiFetch(`/api/connections/${id}/send`, {
        method: "POST",
        body: JSON.stringify({ chatId, text: messageText }),
      });
      toast("Message sent", "success");
      setSendText("");
    } catch (err) {
      // Remove optimistic message on failure
      if (selectedChat && selectedChat.id === chatId) {
        setMessages((prev) => prev.filter((m) => !m.id?.startsWith("temp-")));
      }
      toast(
        err instanceof Error ? err.message : "Failed to send message",
        "error"
      );
    } finally {
      setSending(false);
    }
  }

  const filteredChats = sendChatId
    ? chats.filter(
        (c) =>
          c.id.toLowerCase().includes(sendChatId.toLowerCase()) ||
          (c.name && c.name.toLowerCase().includes(sendChatId.toLowerCase()))
      )
    : chats;

  const displayName =
    customName || connection?.name || "Unnamed Connection";

  const backLink = (
    <Link
      href="/connections"
      className="inline-flex items-center gap-1.5 text-sm text-text-secondary transition-colors duration-150 hover:text-text-primary"
    >
      <svg
        className="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
      Back to Connections
    </Link>
  );

  if (loading) {
    return (
      <div>
        {backLink}
        <ConnectionDetailSkeleton />
      </div>
    );
  }

  if (error && !connection) {
    return (
      <div>
        {backLink}
        <div className="mt-6 rounded-lg border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      {backLink}

      <div className="mt-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            {editingName ? (
              <input
                ref={nameInputRef}
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                onBlur={handleNameSave}
                onKeyDown={handleNameKeyDown}
                className="rounded-lg border border-wa-green bg-bg-elevated px-2 py-1 text-2xl font-bold text-text-primary focus:outline-none focus:ring-1 focus:ring-wa-green"
                placeholder="Connection name"
              />
            ) : (
              <>
                <h1 className="text-2xl font-bold text-text-primary">
                  {displayName}
                </h1>
                <button
                  onClick={handleNameEdit}
                  className="rounded-md p-1 text-text-tertiary transition-colors duration-150 hover:text-wa-green"
                  title="Rename connection"
                  type="button"
                >
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                    />
                  </svg>
                </button>
              </>
            )}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <StatusBadge status={connection?.status ?? "pending"} />
            <span className="text-xs text-text-tertiary font-mono">{id}</span>
            <CopyButton text={id} />
          </div>
        </div>
        <button
          onClick={handleDelete}
          className="shrink-0 rounded-lg border border-status-error-border px-3 py-1.5 text-xs font-medium text-status-error-text transition-colors duration-150 hover:bg-status-error-bg"
        >
          Delete
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          {error}
        </div>
      )}

      {/* QR Code section */}
      {(connection?.status === "scan_qr" ||
        connection?.status === "pending") && (
        <div className="mt-8 rounded-xl border border-border-secondary bg-bg-secondary p-6">
          <h2 className="text-base font-semibold text-text-primary">
            Scan QR Code
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            Open WhatsApp on your phone and scan this QR code to connect.
          </p>

          <div className="mt-6">
            {qrError && (
              <div className="rounded-lg border border-status-warning-border bg-status-warning-bg p-4 text-sm text-status-warning-text">
                {connection.status === "pending"
                  ? "Waiting for QR code to be generated..."
                  : `Failed to load QR code: ${qrError}`}
              </div>
            )}

            {qr && (
              <div className="flex justify-center">
                <img
                  src={`data:${qr.mimetype};base64,${qr.value}`}
                  alt="WhatsApp QR Code"
                  className="h-64 w-64 rounded-lg"
                />
              </div>
            )}

            {!qr && !qrError && (
              <div className="mx-auto flex h-64 w-64 items-center justify-center rounded-lg border border-border-primary bg-bg-elevated">
                <div className="h-48 w-48 animate-pulse rounded-lg bg-bg-hover" />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Connected section */}
      {connection?.status === "working" && (
        <div className="mt-8 space-y-4">
          <div className="rounded-xl border border-status-success-border bg-status-success-bg p-6">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-base font-semibold text-status-success-text">
                  Connected
                </h2>
                {profile && (
                  <p className="mt-1 text-sm text-status-success-text opacity-80">
                    {profile.id.replace("@c.us", "")}
                    {profile.pushName && ` · ${profile.pushName}`}
                  </p>
                )}
                {!profile && connection.me?.id && (
                  <p className="mt-1 text-sm text-status-success-text opacity-80">
                    {connection.me.id.replace("@c.us", "")}
                    {connection.me.pushName && ` · ${connection.me.pushName}`}
                  </p>
                )}
              </div>
              <button
                onClick={handleRestart}
                disabled={restarting}
                className="shrink-0 rounded-lg border border-status-success-border bg-bg-primary px-3 py-1.5 text-xs font-medium text-status-success-text transition-colors duration-150 hover:bg-bg-hover disabled:opacity-50"
              >
                {restarting ? "Restarting..." : "Restart"}
              </button>
            </div>
          </div>

          {/* Mini Chat Viewer */}
          {chats.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border-secondary bg-bg-secondary">
              <div className="flex h-[500px]">
                {/* Left panel: Chat list */}
                <div className="flex w-72 shrink-0 flex-col border-r border-border-primary">
                  <div className="border-b border-border-primary px-4 py-3">
                    <h2 className="text-sm font-semibold text-text-primary">
                      Chats
                    </h2>
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {chats.map((chat) => {
                      const isSelected = selectedChat?.id === chat.id;
                      return (
                        <button
                          key={chat.id}
                          type="button"
                          onClick={() => {
                            setSelectedChat(chat);
                            setSendChatId(chat.id);
                            setShowChatSuggestions(false);
                          }}
                          className={`flex w-full items-center gap-3 border-b border-border-primary/50 px-4 py-3 text-left transition-colors duration-150 hover:bg-bg-hover ${
                            isSelected
                              ? "border-l-2 border-l-wa-green bg-bg-elevated"
                              : "border-l-2 border-l-transparent"
                          }`}
                        >
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-sm font-medium text-text-secondary">
                            {(
                              chat.name?.[0] ||
                              chat.id[0] ||
                              "?"
                            ).toUpperCase()}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-text-primary">
                              {chat.name ||
                                chat.id
                                  .replace("@c.us", "")
                                  .replace("@g.us", "")}
                            </p>
                            {chat.lastMessage && (
                              <p className="mt-0.5 truncate text-xs text-text-tertiary">
                                {chat.lastMessage.fromMe ? "You: " : ""}
                                {chat.lastMessage.body}
                              </p>
                            )}
                          </div>
                          {chat.lastMessage && (
                            <span className="shrink-0 text-[10px] text-text-tertiary">
                              {new Date(
                                chat.lastMessage.timestamp * 1000
                              ).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Right panel: Selected chat / send message */}
                <div className="flex flex-1 flex-col bg-bg-primary">
                  {selectedChat ? (
                    <>
                      {/* Chat header */}
                      <div className="flex items-center gap-3 border-b border-border-primary px-5 py-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-sm font-medium text-text-secondary">
                          {(
                            selectedChat.name?.[0] ||
                            selectedChat.id[0] ||
                            "?"
                          ).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-text-primary">
                            {selectedChat.name ||
                              selectedChat.id
                                .replace("@c.us", "")
                                .replace("@g.us", "")}
                          </p>
                          <p className="truncate text-xs text-text-tertiary font-mono">
                            {selectedChat.id}
                          </p>
                        </div>
                        <div className="ml-auto">
                          <CopyButton text={selectedChat.id} />
                        </div>
                      </div>

                      {/* Chat messages */}
                      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
                        {messagesLoading ? (
                          <div className="flex h-full items-center justify-center">
                            <div className="text-sm text-text-tertiary animate-pulse">Loading messages...</div>
                          </div>
                        ) : messages.length === 0 ? (
                          <div className="flex h-full items-center justify-center">
                            <p className="text-sm text-text-tertiary">No messages yet. Send one below.</p>
                          </div>
                        ) : (
                          <>
                            {messages.map((msg, i) => {
                              const isMe = msg.fromMe;
                              const body = msg.body || "";
                              if (!body) return null;
                              const time = msg.timestamp
                                ? new Date(msg.timestamp * 1000).toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })
                                : "";
                              return (
                                <div
                                  key={msg.id || i}
                                  className={`flex ${isMe ? "justify-end" : "justify-start"}`}
                                >
                                  <div
                                    className={`max-w-[75%] rounded-lg px-3 py-1.5 text-sm ${
                                      isMe
                                        ? "bg-wa-green/20 text-text-primary"
                                        : "bg-bg-secondary text-text-primary"
                                    }`}
                                  >
                                    <p className="whitespace-pre-wrap break-words">{body}</p>
                                    <p className={`mt-0.5 text-[10px] ${isMe ? "text-right" : ""} text-text-tertiary`}>
                                      {time}
                                    </p>
                                  </div>
                                </div>
                              );
                            })}
                            <div ref={messagesEndRef} />
                          </>
                        )}
                      </div>

                      {/* Send message input */}
                      <form
                        onSubmit={handleSendMessage}
                        className="flex items-center gap-2 border-t border-border-primary bg-bg-secondary px-4 py-3"
                      >
                        <input
                          type="text"
                          value={sendText}
                          onChange={(e) => setSendText(e.target.value)}
                          placeholder="Type a message..."
                          disabled={sending}
                          className="flex-1 rounded-lg border border-border-secondary bg-bg-elevated px-3.5 py-2 text-sm text-text-primary transition-colors duration-150 placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green disabled:opacity-50"
                        />
                        <button
                          type="submit"
                          disabled={sending || !sendText.trim()}
                          className="rounded-lg bg-wa-green p-2 text-text-inverse transition-colors duration-150 hover:bg-wa-green-dark disabled:opacity-50"
                        >
                          {sending ? (
                            <svg
                              className="h-5 w-5 animate-spin"
                              fill="none"
                              viewBox="0 0 24 24"
                            >
                              <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                              />
                              <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                              />
                            </svg>
                          ) : (
                            <svg
                              className="h-5 w-5"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                              />
                            </svg>
                          )}
                        </button>
                      </form>
                    </>
                  ) : (
                    <div className="flex flex-1 items-center justify-center">
                      <div className="text-center">
                        <svg
                          className="mx-auto h-12 w-12 text-text-tertiary opacity-50"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={1}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                          />
                        </svg>
                        <p className="mt-3 text-sm text-text-tertiary">
                          Select a chat to send a message
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Send Message - standalone form when no chats */}
          {chats.length === 0 && (
            <div className="rounded-xl border border-border-secondary bg-bg-secondary p-6">
              <h2 className="text-base font-semibold text-text-primary">
                Send Message
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                Send a WhatsApp message from this connection.
              </p>
              <form onSubmit={handleSendMessage} className="mt-4 space-y-3">
                <div className="relative">
                  <label
                    htmlFor="send-chat-id"
                    className="mb-1.5 block text-sm font-medium text-text-secondary"
                  >
                    Chat ID
                  </label>
                  <input
                    ref={chatInputRef}
                    id="send-chat-id"
                    type="text"
                    value={sendChatId}
                    onChange={(e) => {
                      setSendChatId(e.target.value);
                      setShowChatSuggestions(true);
                    }}
                    onFocus={() => setShowChatSuggestions(true)}
                    onBlur={() => {
                      setTimeout(() => setShowChatSuggestions(false), 150);
                    }}
                    placeholder="e.g. 5511999999999@c.us"
                    disabled={sending}
                    className="block w-full rounded-lg border border-border-secondary bg-bg-elevated px-3.5 py-2.5 text-sm text-text-primary transition-colors duration-150 placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green disabled:opacity-50"
                  />
                  {showChatSuggestions && filteredChats.length > 0 && (
                    <div className="absolute z-10 mt-1 max-h-40 w-full overflow-y-auto rounded-lg border border-border-secondary bg-bg-elevated shadow-lg">
                      {filteredChats.slice(0, 8).map((chat) => (
                        <button
                          key={chat.id}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setSendChatId(chat.id);
                            setShowChatSuggestions(false);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-bg-hover"
                        >
                          <span className="truncate font-medium text-text-primary">
                            {chat.name ||
                              chat.id
                                .replace("@c.us", "")
                                .replace("@g.us", "")}
                          </span>
                          <span className="shrink-0 text-xs text-text-tertiary font-mono">
                            {chat.id}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <label
                    htmlFor="send-text"
                    className="mb-1.5 block text-sm font-medium text-text-secondary"
                  >
                    Message
                  </label>
                  <input
                    id="send-text"
                    type="text"
                    value={sendText}
                    onChange={(e) => setSendText(e.target.value)}
                    placeholder="Type your message..."
                    disabled={sending}
                    className="block w-full rounded-lg border border-border-secondary bg-bg-elevated px-3.5 py-2.5 text-sm text-text-primary transition-colors duration-150 placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green disabled:opacity-50"
                  />
                </div>
                <button
                  type="submit"
                  disabled={sending || !sendChatId.trim() || !sendText.trim()}
                  className="rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors duration-150 hover:bg-wa-green-dark disabled:opacity-50"
                >
                  {sending ? "Sending..." : "Send"}
                </button>
              </form>
            </div>
          )}
        </div>
      )}

      {/* Failed section */}
      {connection?.status === "failed" && (
        <div className="mt-8 rounded-xl border border-status-error-border bg-status-error-bg p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-base font-semibold text-status-error-text">
                Connection Failed
              </h2>
              <p className="mt-1 text-sm text-status-error-text opacity-80">
                Something went wrong. Try restarting the connection.
              </p>
            </div>
            <button
              onClick={handleRestart}
              disabled={restarting}
              className="shrink-0 rounded-lg border border-status-error-border bg-bg-primary px-3 py-1.5 text-xs font-medium text-status-error-text transition-colors duration-150 hover:bg-bg-hover disabled:opacity-50"
            >
              {restarting ? "Restarting..." : "Restart"}
            </button>
          </div>
        </div>
      )}

      {/* Webhooks section */}
      <WebhookList connectionId={id} />
    </div>
  );
}
