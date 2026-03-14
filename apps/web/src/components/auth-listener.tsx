"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Client-side auth state listener. Keeps the session alive by
 * responding to TOKEN_REFRESHED events and redirecting on SIGNED_OUT.
 * Mount once in the dashboard layout.
 */
export function AuthListener() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        router.push("/login");
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
