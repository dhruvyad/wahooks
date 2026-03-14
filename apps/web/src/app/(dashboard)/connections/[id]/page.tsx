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

// Module-level cache for avatar URLs (persists across re-renders)
const avatarCache = new Map<string, string | null>();

function ChatAvatar({
  connectionId,
  chatId,
  name,
  size = "h-9 w-9",
}: {
  connectionId: string;
  chatId: string;
  name?: string;
  size?: string;
}) {
  const cacheKey = `${connectionId}:${chatId}`;
  const [url, setUrl] = useState<string | null | undefined>(
    avatarCache.has(cacheKey) ? avatarCache.get(cacheKey)! : undefined
  );

  useEffect(() => {
    if (avatarCache.has(cacheKey)) {
      setUrl(avatarCache.get(cacheKey)!);
      return;
    }
    let cancelled = false;
    apiFetch(
      `/api/connections/${connectionId}/contacts/${encodeURIComponent(chatId)}/picture`
    )
      .then((data: { profilePictureUrl: string | null }) => {
        if (!cancelled) {
          avatarCache.set(cacheKey, data.profilePictureUrl);
          setUrl(data.profilePictureUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          avatarCache.set(cacheKey, null);
          setUrl(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, chatId, cacheKey]);

  const letter = (name?.[0] || chatId[0] || "?").toUpperCase();

  if (url) {
    return (
      <img
        src={url}
        alt={name || chatId}
        className={`${size} shrink-0 rounded-full object-cover`}
      />
    );
  }

  return (
    <div
      className={`flex ${size} shrink-0 items-center justify-center rounded-full bg-bg-elevated text-sm font-medium text-text-secondary`}
    >
      {letter}
    </div>
  );
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

  // Fullscreen mode
  const [fullscreen, setFullscreen] = useState(false);

  // Media sending mode
  const [mediaMode, setMediaMode] = useState<null | "image" | "file" | "voice">(null);
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaCaption, setMediaCaption] = useState("");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // ESC key handler for fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setFullscreen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fullscreen]);

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

  async function handleSendMedia(e: React.FormEvent) {
    e.preventDefault();
    if (!sendChatId.trim() || !mediaMode) return;
    if (!mediaFile && !mediaUrl.trim()) return;

    setSending(true);
    try {
      const payload: any = {
        chatId: sendChatId.trim(),
        type: mediaMode,
      };

      if (mediaFile) {
        // Convert file to base64
        const arrayBuffer = await mediaFile.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
        );
        payload.mediaData = base64;
        payload.mimetype = mediaFile.type;
        payload.filename = mediaFile.name;
      } else {
        payload.mediaUrl = mediaUrl.trim();
      }

      if (mediaMode !== "voice" && mediaCaption.trim()) {
        payload.caption = mediaCaption.trim();
      }

      await apiFetch(`/api/connections/${id}/send-media`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast("Media sent", "success");
      exitMediaMode();
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Failed to send media",
        "error"
      );
    } finally {
      setSending(false);
    }
  }

  function exitMediaMode() {
    setMediaMode(null);
    setMediaUrl("");
    setMediaCaption("");
    setMediaFile(null);
    setShowAttachMenu(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
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
            <div
              className={`overflow-hidden bg-bg-secondary ${
                fullscreen
                  ? "fixed inset-0 z-50"
                  : "rounded-xl border border-border-secondary"
              }`}
            >
              <div className={`flex ${fullscreen ? "h-full" : "h-[500px]"}`}>
                {/* Left panel: Chat list */}
                <div className="flex w-72 shrink-0 flex-col border-r border-border-primary">
                  <div className="flex items-center justify-between border-b border-border-primary px-4 py-3">
                    <h2 className="text-sm font-semibold text-text-primary">
                      Chats
                    </h2>
                    <button
                      type="button"
                      onClick={() => setFullscreen((f) => !f)}
                      className="rounded-md p-1 text-text-tertiary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
                      title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                    >
                      {fullscreen ? (
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 9L4 4m0 0v4m0-4h4m6 6l5 5m0 0v-4m0 4h-4M9 15l-5 5m0 0h4m-4 0v-4m11-6l5-5m0 0h-4m4 0v4" />
                        </svg>
                      ) : (
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
                        </svg>
                      )}
                    </button>
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
                          <ChatAvatar
                            connectionId={id}
                            chatId={chat.id}
                            name={chat.name}
                          />
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
                        <ChatAvatar
                          connectionId={id}
                          chatId={selectedChat.id}
                          name={selectedChat.name}
                        />
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

                      {/* Send message / media input */}
                      {mediaMode ? (
                        <form
                          onSubmit={handleSendMedia}
                          className="border-t border-border-primary bg-bg-secondary px-4 py-3 space-y-2"
                        >
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={exitMediaMode}
                              className="rounded-md p-1 text-text-tertiary transition-colors duration-150 hover:text-text-primary"
                              title="Back to text"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                              </svg>
                            </button>
                            <span className="text-xs font-semibold uppercase text-wa-green">
                              {mediaMode === "image" ? "Image" : mediaMode === "file" ? "File" : "Voice"}
                            </span>
                          </div>
                          {/* File upload or URL */}
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => fileInputRef.current?.click()}
                              className="shrink-0 rounded-lg border border-border-secondary bg-bg-elevated px-3 py-2 text-xs font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
                            >
                              {mediaFile ? mediaFile.name.slice(0, 20) + (mediaFile.name.length > 20 ? "..." : "") : "Choose file"}
                            </button>
                            <input
                              ref={fileInputRef}
                              type="file"
                              accept={mediaMode === "image" ? "image/*" : mediaMode === "voice" ? "audio/*" : "*/*"}
                              className="hidden"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) {
                                  setMediaFile(f);
                                  setMediaUrl("");
                                }
                              }}
                            />
                            <span className="text-xs text-text-tertiary">or</span>
                            <input
                              type="url"
                              value={mediaUrl}
                              onChange={(e) => { setMediaUrl(e.target.value); setMediaFile(null); }}
                              placeholder="Paste URL"
                              disabled={sending || !!mediaFile}
                              className="flex-1 rounded-lg border border-border-secondary bg-bg-elevated px-3 py-2 text-sm text-text-primary transition-colors duration-150 placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green disabled:opacity-50"
                            />
                          </div>
                          {mediaMode !== "voice" && (
                            <input
                              type="text"
                              value={mediaCaption}
                              onChange={(e) => setMediaCaption(e.target.value)}
                              placeholder="Caption (optional)"
                              disabled={sending}
                              className="block w-full rounded-lg border border-border-secondary bg-bg-elevated px-3.5 py-2 text-sm text-text-primary transition-colors duration-150 placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green disabled:opacity-50"
                            />
                          )}
                          <button
                            type="submit"
                            disabled={sending || (!mediaFile && !mediaUrl.trim())}
                            className="rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors duration-150 hover:bg-wa-green-dark disabled:opacity-50"
                          >
                            {sending ? "Sending..." : "Send"}
                          </button>
                        </form>
                      ) : (
                        <form
                          onSubmit={handleSendMessage}
                          className="flex items-center gap-2 border-t border-border-primary bg-bg-secondary px-4 py-3"
                        >
                          {/* Attachment button */}
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() => setShowAttachMenu((v) => !v)}
                              className="rounded-md p-1.5 text-text-tertiary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
                              title="Attach media"
                            >
                              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                              </svg>
                            </button>
                            {showAttachMenu && (
                              <div className="absolute bottom-full left-0 mb-2 w-36 rounded-lg border border-border-secondary bg-bg-elevated shadow-lg">
                                {(["image", "file", "voice"] as const).map((type) => (
                                  <button
                                    key={type}
                                    type="button"
                                    onClick={() => {
                                      setMediaMode(type);
                                      setShowAttachMenu(false);
                                    }}
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text-primary transition-colors duration-150 first:rounded-t-lg last:rounded-b-lg hover:bg-bg-hover"
                                  >
                                    <span className="text-text-tertiary">
                                      {type === "image" ? (
                                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                        </svg>
                                      ) : type === "file" ? (
                                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                        </svg>
                                      ) : (
                                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                                        </svg>
                                      )}
                                    </span>
                                    {type === "image" ? "Image" : type === "file" ? "File" : "Voice"}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
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
                      )}
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
