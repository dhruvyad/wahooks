"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import posthog from "posthog-js";
import { createClient } from "@/lib/supabase/client";

/**
 * Client-side auth state listener. Keeps the session alive by
 * responding to TOKEN_REFRESHED events and redirecting on SIGNED_OUT.
 * Also identifies the user in PostHog for analytics.
 * Mount once in the dashboard layout.
 */
export function AuthListener() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();

    // Identify user in PostHog on mount
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        posthog.identify(user.id, { email: user.email });
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        posthog.reset();
        router.push("/login");
      }
      if (event === "SIGNED_IN" && session?.user) {
        posthog.identify(session.user.id, { email: session.user.email });
      }
      if (event === "TOKEN_REFRESHED") {
        // Token refreshed successfully — router.refresh() ensures
        // server components re-run with the updated cookies
        router.refresh();
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [router]);

  return null;
}
