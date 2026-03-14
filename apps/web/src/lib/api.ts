const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export async function apiFetch(path: string, options: RequestInit = {}) {
  const { createClient } = await import("@/lib/supabase/client");
  const supabase = createClient();

  // getSession() auto-refreshes expired tokens on the client
  let {
    data: { session },
  } = await supabase.auth.getSession();

  // If session is expired or missing, try refreshing explicitly
  if (!session?.access_token) {
    const { data } = await supabase.auth.refreshSession();
    session = data.session;
  }

  if (!session?.access_token) {
    // Still no session — redirect to login
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
    // Token rejected by API — try one more refresh
    const { data } = await supabase.auth.refreshSession();
    if (data.session?.access_token) {
      const retry = await fetch(`${API_URL}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.session.access_token}`,
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
    throw new Error(`API error ${res.status}: ${body}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
