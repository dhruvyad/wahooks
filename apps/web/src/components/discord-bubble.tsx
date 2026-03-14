"use client";

export function DiscordBubble() {
  return (
    <a
      href="https://discord.gg/B2XNf97Vby"
      target="_blank"
      rel="noopener noreferrer"
      className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-wa-green text-white shadow-lg shadow-wa-green/25 transition-all hover:scale-110 hover:shadow-xl hover:shadow-wa-green/30"
      aria-label="Join our Discord community"
    >
      {/* Chat bubble icon */}
      <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none">
        {/* Bubble body */}
        <path
          d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5.586a1 1 0 0 0-.707.293l-2.414 2.414a.5.5 0 0 1-.854-.353V18.5a.5.5 0 0 0-.5-.5H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"
          fill="rgba(255,255,255,0.15)"
          stroke="currentColor"
          strokeWidth={1.5}
        />
        {/* Three dots */}
        <circle cx="8" cy="11" r="1.25" fill="currentColor" />
        <circle cx="12" cy="11" r="1.25" fill="currentColor" />
        <circle cx="16" cy="11" r="1.25" fill="currentColor" />
      </svg>
    </a>
  );
}
