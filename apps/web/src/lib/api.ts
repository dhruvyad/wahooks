const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export async function apiFetch(path: string, options: RequestInit = {}) {
  const { createClient } = await import("@/lib/supabase/client");
  const supabase = createClient();

  // getSession() auto-refreshes expired tokens via the Supabase client.
  // The browser client has autoRefreshToken enabled by default.
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error || !session?.access_token) {
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new Error("Not authenticated");
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      ...options.headers,
    },
  });

  if (res.status === 401) {
    // Token was rejected — force a refresh and redirect if it fails
    const { error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError) {
      if (typeof window !== "undefined") {
        window.location.href = "/login";
      }
      throw new Error("Session expired");
    }
    // Retry once with the refreshed session
    const { data: { session: newSession } } = await supabase.auth.getSession();
    if (newSession?.access_token) {
      const retry = await fetch(`${API_URL}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${newSession.access_token}`,
          ...options.headers,
        },
      });
      if (retry.ok) {
        const text = await retry.text();
        return text ? JSON.parse(text) : null;
      }
    }
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new Error("Session expired");
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `API error ${res.status}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
