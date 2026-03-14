import posthog from "posthog-js";

if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    capture_pageview: true,
    capture_pageleave: true,
    capture_performance: true,
    session_recording: {
      recordCrossOriginIframes: true,
    },
    defaults: "2026-01-30",
  });
}
