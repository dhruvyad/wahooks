import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WAHooks — WhatsApp Webhooks, Instant Setup",
  description:
    "Connect WhatsApp numbers, receive real-time webhooks, and send messages — all through a simple API. No infrastructure to manage.",
  metadataBase: new URL("https://wahooks.com"),
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "WAHooks — WhatsApp Webhooks, Instant Setup",
    description:
      "Connect WhatsApp numbers, receive real-time webhooks, and send messages — all through a simple API.",
    url: "https://wahooks.com",
    siteName: "WAHooks",
    type: "website",
    images: [{ url: "/icon-512.png", width: 512, height: 512 }],
  },
  twitter: {
    card: "summary",
    title: "WAHooks — WhatsApp Webhooks, Instant Setup",
    description:
      "Connect WhatsApp numbers, receive real-time webhooks, and send messages — all through a simple API.",
    images: ["/icon-512.png"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" style={{ colorScheme: "dark" }} suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "WAHooks",
              url: "https://wahooks.com",
              logo: "https://wahooks.com/icon-512.png",
              sameAs: [
                "https://github.com/dhruvyad/wahooks",
                "https://x.com/dhruvyad",
                "https://discord.gg/B2XNf97Vby",
              ],
              description:
                "Cloud-hosted WhatsApp webhooks. Connect WhatsApp numbers, receive real-time webhooks, and send messages through a simple API.",
            }),
          }}
        />
      </head>
      <body>
        <RootProvider theme={{ defaultTheme: "dark", forcedTheme: "dark" }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
