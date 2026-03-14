import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider";
import "fumadocs-ui/style.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "WAHooks",
  description: "Cloud-hosted WhatsApp webhooks",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-bg-primary text-text-primary antialiased">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
